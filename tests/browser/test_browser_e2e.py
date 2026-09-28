"""The public background-tool sequence through the shipped page and real Chromium."""

import asyncio

import pytest

pytestmark = pytest.mark.browser_e2e


async def wait_for_frame(frames, predicate):
    async with asyncio.timeout(5):
        while not any(predicate(frame) for frame in frames):
            await asyncio.sleep(0.01)


async def open_session(page):
    await page.locator("#voice").click()
    await page.locator("#voice").get_by_text("Mute microphone", exact=True).wait_for()


async def test_page_is_a_voice_only_remote_for_the_visible_pi_terminal(browser_page):
    page, errors = browser_page
    assert await page.locator("#text").count() == 0
    assert await page.locator("#send").count() == 0
    assert await page.locator("#log").count() == 1
    await open_session(page)
    assert await page.evaluate("__fakeDialt.clients.length") == 1
    assert errors == []


async def test_voice_session_uses_coding_friendly_idle_timing(browser_page):
    page, _ = browser_page
    await open_session(page)

    mode = await page.evaluate("__fakeDialt.clients[0].options.mode")

    assert mode["kind"] == "dialt"
    assert mode["silence_nudge_s"] == 30
    assert mode["silence_end_s"] == 90


async def test_voice_session_routes_all_pi_session_questions_to_pi(browser_page):
    page, _ = browser_page
    await open_session(page)

    instructions = await page.evaluate(
        "__fakeDialt.clients[0].options.mode.instructions",
    )

    assert "Pi is the authoritative source for its coding session" in instructions
    assert "every request or question concerning Pi or that session" in instructions
    assert "never answer it yourself" in instructions
    mode = await page.evaluate("__fakeDialt.clients[0].options.mode")
    assert mode["tool_choice"] == {"tool": "pi_request"}


async def test_end_session_closes_voice_and_requests_host_shutdown(
    browser_page, browser_server,
):
    page, _ = browser_page
    _, _, frames = browser_server
    await open_session(page)

    await page.locator("#end-session").click()

    await wait_for_frame(frames, lambda frame: frame.get("event") == "end_session")
    assert await page.locator("#status").inner_text() == "ended"
    assert await page.locator("#voice").is_disabled()
    assert await page.locator("#end-session").is_disabled()
    assert await page.evaluate("__fakeDialt.clients[0].closed") is True


async def test_end_session_never_waits_for_an_audio_diagnostic_upload(
    browser_page, browser_server,
):
    page, _ = browser_page
    _, _, frames = browser_server
    await open_session(page)
    await page.evaluate("""const realFetch=window.fetch.bind(window);
      window.fetch=(url,options)=>String(url).startsWith('/audio-diagnostic')
        ? new Promise(()=>{}) : realFetch(url,options);
      __fakeDialt.clients[0].emit({type:'turn',turn_id:'reply-pending'});
      __fakeDialt.clients[0].emit({
        type:'audio',sr:16000,samples:new Float32Array([0,0.25,-0.25])
      });""")

    await page.locator("#end-session").click()

    await wait_for_frame(frames, lambda frame: frame.get("event") == "end_session")
    assert await page.locator("#status").inner_text() == "ended"
    assert await page.locator("#voice").is_disabled()


async def test_end_session_during_voice_open_cannot_resurrect_the_session(
    browser_page, browser_server,
):
    page, _ = browser_page
    _, _, frames = browser_server
    await page.evaluate("__fakeDialt.connectHold=true")
    await page.locator("#voice").click()
    await page.wait_for_function("typeof __fakeDialt.releaseConnect==='function'")

    await page.locator("#end-session").click()
    await wait_for_frame(frames, lambda frame: frame.get("event") == "end_session")
    assert await page.evaluate("__fakeDialt.clients[0].closed") is True
    await page.evaluate("__fakeDialt.releaseConnect()")
    await page.wait_for_timeout(100)

    assert await page.locator("#status").inner_text() == "ended"
    assert await page.locator("#voice").is_disabled()
    assert await page.evaluate("__fakeDialt.clients[0].closed") is True
    assert await page.evaluate("__fakeDialt.clients[0].stream") is None
    assert not any(frame.get("event") == "bridge_ready" for frame in frames)


async def test_browser_renders_and_traces_sdk_mic_lifecycle(
    browser_page, browser_server,
):
    page, _ = browser_page
    _, _, frames = browser_server

    await open_session(page)
    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "debug_trace"
        and frame.get("name") == "mic_state"
        and frame.get("data", {}).get("state") == "warming_up",
    )
    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "debug_trace"
        and frame.get("name") == "mic_state"
        and frame.get("data", {}).get("state") == "listening",
    )
    assert await page.locator("#status").inner_text() == "listening"
    await page.locator("#voice").click()
    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "debug_trace"
        and frame.get("name") == "mic_state"
        and frame.get("data") == {"state": "muted"},
    )
    await page.locator("#voice").click()
    assert await page.evaluate("__fakeDialt.clients[0].micEnabled") is True


async def test_debug_session_captures_received_assistant_audio_with_chunk_evidence(
    browser_page, browser_server,
):
    page, _ = browser_page
    _, _, frames = browser_server
    await open_session(page)

    await page.evaluate("""__fakeDialt.clients[0].emit({type:'turn',turn_id:'reply-audio'});
      __fakeDialt.clients[0].emit({
        type:'audio',turn_id:'reply-audio',sr:16000,
        samples:new Float32Array([0,0.25,-0.25,0.5])
      });
      __fakeDialt.clients[0].emit({
        type:'audio',turn_id:'reply-audio',sr:16000,
        samples:new Float32Array([0.5,-0.5,0])
      });
      __fakeDialt.clients[0].emit({type:'done',turn_id:'reply-audio'});""")

    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "audio_capture"
        and frame.get("turn_id") == "reply-audio",
    )
    capture = next(frame for frame in frames if frame.get("event") == "audio_capture")
    assert len(capture["pcm16"]) == 14
    trace = next(
        frame for frame in frames
        if frame.get("event") == "debug_trace"
        and frame.get("name") == "assistant_audio"
    )
    assert trace["data"]["turn_id"] == "reply-audio"
    assert trace["data"]["sample_rate"] == 16000
    assert trace["data"]["sample_count"] == 7
    assert len(trace["data"]["chunks"]) == 2
    assert trace["data"]["chunks"][1]["boundary_jump"] == pytest.approx(0)


async def test_browser_renders_sdk_mic_recovery_without_owning_retry(
    browser_page, browser_server,
):
    page, _ = browser_page
    _, _, frames = browser_server
    await open_session(page)

    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'recovering',code:'capture_stalled',attempt:1,next_attempt:2
    })""")
    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "debug_trace"
        and frame.get("name") == "mic_state"
        and frame.get("data", {}).get("state") == "recovering",
    )
    assert await page.locator("#status").inner_text() == "recovering"


async def test_page_streams_user_speech_assistant_text_and_tool_activity(browser_page):
    page, _ = browser_page
    await open_session(page)

    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'asr', text:'List the files', final:true, turn_id:'user-1'
    })""")
    await page.evaluate("""__fakeDialt.clients[0].emit({type:'turn',turn_id:'reply-1'});
      __fakeDialt.clients[0].emit({type:'text_delta',delta:'I will inspect ',turn_id:'reply-1'});
      __fakeDialt.clients[0].emit({type:'text_delta',delta:'the repository.',turn_id:'reply-1'});
      __fakeDialt.clients[0].emit({type:'done',turn_id:'reply-1'});""")
    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'tool_call', id:'task-1', name:'pi_request', args:{user_request:'List the files'}
    })""")

    assert await page.locator(".entry.user").get_by_text("List the files", exact=True).count() == 1
    assert await page.locator(".entry.assistant").get_by_text(
        "I will inspect the repository.", exact=True,
    ).count() == 1
    assert await page.locator(".entry.activity").get_by_text(
        "Requested pi_request", exact=True,
    ).count() == 1

    styles = await page.evaluate("""() => {
      const user=getComputedStyle(document.querySelector('.entry.user'));
      const assistant=getComputedStyle(document.querySelector('.entry.assistant'));
      return {
        userBackground:user.backgroundColor,
        assistantBackground:assistant.backgroundColor,
        userBorder:user.borderColor,
        assistantBorder:assistant.borderColor,
      };
    }""")
    assert styles["userBackground"] != styles["assistantBackground"]
    assert styles["userBorder"] != styles["assistantBorder"]
    assert await page.locator(".entry.user").get_attribute("data-label") == "You"
    assert await page.locator(".entry.assistant").get_attribute("data-label") == "Converse Code"
    assert await page.locator(".entry.user").get_attribute("aria-label") == "You"
    assert await page.locator(".entry.assistant").get_attribute("aria-label") == "Converse Code"


async def test_transcript_follows_new_rows_and_streaming_text_to_the_bottom(browser_page):
    page, _ = browser_page
    await open_session(page)

    await page.evaluate("""for(let index=0;index<40;index++){
      __fakeDialt.clients[0].emit({
        type:'asr',text:`User message ${index}`,final:true,turn_id:`user-${index}`
      });
    }""")
    await page.wait_for_timeout(50)
    after_rows = await page.locator("#log").evaluate(
        "el => ({top:el.scrollTop,max:el.scrollHeight-el.clientHeight})",
    )
    assert after_rows["max"] > 0
    assert after_rows["max"] - after_rows["top"] <= 1

    await page.evaluate("""__fakeDialt.clients[0].emit({type:'turn',turn_id:'long-reply'});
      for(let index=0;index<80;index++){
        __fakeDialt.clients[0].emit({
          type:'text_delta',delta:`Streaming line ${index}.\\n`,turn_id:'long-reply'
        });
      }""")
    await page.wait_for_timeout(50)
    after_stream = await page.locator("#log").evaluate(
        "el => ({top:el.scrollTop,max:el.scrollHeight-el.clientHeight})",
    )
    assert after_stream["max"] > after_rows["max"]
    assert after_stream["max"] - after_stream["top"] <= 1


async def test_asr_without_a_final_flag_is_recorded_without_local_end_routing(
    browser_page, browser_server,
):
    page, _ = browser_page
    _, _, frames = browser_server
    await open_session(page)

    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'asr',text:'End the session',turn_id:'user-end'
    })""")
    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "debug_trace"
        and frame.get("name") == "user_transcript",
    )

    transcript = next(frame for frame in frames if frame.get("name") == "user_transcript")
    assert transcript["data"] == {"turn_id": "user-end", "text": "End the session"}

    assert not any(frame.get("event") == "session_end" for frame in frames)


async def test_sdk_session_end_is_forwarded_to_the_host(browser_page, browser_server):
    page, _ = browser_page
    _, _, frames = browser_server
    await open_session(page)

    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'session_end',code:1000,reason:'idle'
    })""")
    await wait_for_frame(frames, lambda frame: frame.get("event") == "session_end")

    ended = next(frame for frame in frames if frame.get("event") == "session_end")
    assert ended == {
        "type": "local", "event": "session_end", "code": 1000, "reason": "idle",
    }
    assert await page.locator("#status").inner_text() == "ended"
    assert await page.locator("#voice").inner_text() == "Session ended"
    assert await page.locator("#voice").is_disabled()
    assert await page.locator("#voice").get_attribute("aria-pressed") == "false"
    assert await page.evaluate("__fakeDialt.clients[0].stream") is None


async def test_late_interrupted_utterance_updates_one_assistant_row(browser_page):
    page, _ = browser_page
    await open_session(page)

    await page.evaluate("""__fakeDialt.clients[0].emit({type:'turn',turn_id:'reply-1'});
      __fakeDialt.clients[0].emit({type:'text_delta',delta:'Hello there.',turn_id:'reply-1'});
      __fakeDialt.clients[0].emit({type:'interrupted',turn_id:'reply-1'});
      __fakeDialt.clients[0].emit({
        type:'utterance',text:'Hello there. [interrupted]',turn_id:'reply-1'
      });""")

    assert await page.locator(".entry.assistant").count() == 1
    assert await page.locator(".entry.assistant").inner_text() == "Hello there. [interrupted]"


async def test_late_distinct_utterance_cannot_overwrite_an_earlier_matching_turn(browser_page):
    page, _ = browser_page
    await open_session(page)

    await page.evaluate("""__fakeDialt.clients[0].emit({type:'turn',turn_id:'reply-1'});
      __fakeDialt.clients[0].emit({type:'text_delta',delta:'Hello',turn_id:'reply-1'});
      __fakeDialt.clients[0].emit({type:'interrupted',turn_id:'reply-1'});
      __fakeDialt.clients[0].emit({type:'turn',turn_id:'reply-2'});
      __fakeDialt.clients[0].emit({type:'text_delta',delta:'Hello',turn_id:'reply-2'});
      __fakeDialt.clients[0].emit({type:'interrupted',turn_id:'reply-2'});
      __fakeDialt.clients[0].emit({
        type:'utterance',text:'Hello again [interrupted]',turn_id:'reply-2'
      });""")

    assert await page.locator(".entry.assistant").count() == 2
    assert await page.locator(".entry.assistant").all_text_contents() == [
        "Hello", "Hello again [interrupted]",
    ]


async def test_interaction_partial_is_sent_while_a_voice_turn_is_active(
    browser_page, browser_server,
):
    page, _ = browser_page
    server, _, frames = browser_server
    await open_session(page)
    await page.evaluate("__fakeDialt.clients[0].emit({type:'turn',turn_id:'busy-reply'})")

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 20,
        "action": "tool_partial_result", "id": "task-1",
        "interaction": {
            "id": "approval-1",
            "prompt": "Allow Pi to run bash: pwd?",
            "options": ["Allow once", "Allow for this session", "Block"],
            "resolver": {
                "tool": "pi_approval", "args": {"approval_id": "approval-1"},
                "option_args": {
                    "Allow once": {"decision": "allow_once"},
                    "Allow for this session": {"decision": "allow_session"},
                    "Block": {"decision": "block"},
                },
            },
        },
        "content": {
            "event": "pi_approval_required", "approval_id": "approval-1",
            "tool": "bash", "summary": "pwd",
            "decisions": ["allow_once", "allow_session", "block"],
        },
    })
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 20)
    calls = await page.evaluate("__fakeDialt.clients[0].bridgeCalls")
    assert calls == [{
        "action": "tool_partial_result", "id": "task-1",
        "content": {
            "event": "pi_approval_required", "approval_id": "approval-1",
            "tool": "bash", "summary": "pwd",
            "decisions": ["allow_once", "allow_session", "block"],
        },
        "options": {"interaction": {
            "id": "approval-1",
            "prompt": "Allow Pi to run bash: pwd?",
            "options": ["Allow once", "Allow for this session", "Block"],
            "resolver": {
                "tool": "pi_approval", "args": {"approval_id": "approval-1"},
                "option_args": {
                    "Allow once": {"decision": "allow_once"},
                    "Allow for this session": {"decision": "allow_session"},
                    "Block": {"decision": "block"},
                },
            },
        }},
    }]


async def test_interaction_narration_lifecycle_is_visible_and_traced(
    browser_page, browser_server,
):
    page, _ = browser_page
    _, _, frames = browser_server
    await open_session(page)

    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'tool_job_narration',state:'queued',job_ids:['task-1'],kind:'interaction'
    });
    __fakeDialt.clients[0].emit({
      type:'tool_job_narration',state:'started',job_ids:['task-1'],kind:'interaction'
    });""")

    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "debug_trace"
        and frame.get("name") == "tool_job_narration"
        and frame.get("data", {}).get("state") == "started",
    )
    assert await page.locator(".entry.activity").all_text_contents() == [
        "Question narration queued", "Question narration started",
    ]


async def test_interaction_close_is_acknowledged_by_the_sdk_before_host_delivery_ack(
    browser_page, browser_server,
):
    page, _ = browser_page
    server, _, frames = browser_server
    await open_session(page)
    await page.evaluate("__fakeDialt.interactionUpdateHold=true")

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 21,
        "action": "tool_interaction_update", "id": "task-1",
        "interaction_id": "approval-1", "state": "cancelled",
        "note": "The Pi approval expired unanswered.",
    })
    await page.wait_for_function(
        "typeof __fakeDialt.releaseInteractionUpdate === 'function'",
    )
    assert not any(frame.get("seq") == 21 for frame in frames)

    await page.evaluate("__fakeDialt.releaseInteractionUpdate()")
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 21)
    acknowledgement = next(frame for frame in frames if frame.get("seq") == 21)
    assert acknowledgement["detail"] == {
        "type": "tool_interaction_update_ack", "id": "task-1",
        "interaction_id": "approval-1", "state": "cancelled",
        "applied": True, "reason": None,
    }


async def test_deferred_resume_and_cancelled_interaction_reach_the_local_host(
    browser_page, browser_server,
):
    page, _ = browser_page
    _, _, frames = browser_server
    await open_session(page)

    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'tool_deferred_resume',id:'task-1',handle:'pi-turn',name:'pi_request'
    });
    __fakeDialt.clients[0].emit({
      type:'tool_job_narration',state:'cancelled',job_ids:['task-1'],
      interaction_ids:['approval-1'],kind:'interaction'
    });""")

    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "tool_deferred_resume"
        and frame.get("handle") == "pi-turn",
    )
    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "interaction_cancelled"
        and frame.get("interaction_ids") == ["approval-1"],
    )


async def test_barge_supersedes_only_narration_not_the_pending_interaction(
    browser_page, browser_server,
):
    page, _ = browser_page
    _, _, frames = browser_server
    await open_session(page)

    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'tool_job_narration',state:'started',job_ids:['task-1'],
      interaction_ids:['approval-1'],kind:'interaction'
    });
    __fakeDialt.clients[0].emit({type:'turn',turn_id:'approval-ask'});
    __fakeDialt.clients[0].emit({
      type:'text_delta',delta:'Allow Pi to run that?',turn_id:'approval-ask'
    });
    __fakeDialt.clients[0].emit({type:'interrupted',turn_id:'approval-ask'});
    __fakeDialt.clients[0].emit({
      type:'tool_job_narration',state:'superseded',job_ids:['task-1'],
      interaction_ids:['approval-1'],kind:'interaction'
    });""")
    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "debug_trace"
        and frame.get("name") == "tool_job_narration"
        and frame.get("data", {}).get("state") == "superseded",
    )

    assert not any(frame.get("event") == "interaction_cancelled" for frame in frames)


async def test_trace_captures_assistant_text_at_interruption(browser_page, browser_server):
    page, _ = browser_page
    _, _, frames = browser_server
    await open_session(page)

    await page.evaluate("""__fakeDialt.clients[0].emit({type:'turn',turn_id:'reply-1'});
      __fakeDialt.clients[0].emit({
        type:'text_delta',delta:'Would you like to allow that?',turn_id:'reply-1'
      });
      __fakeDialt.clients[0].emit({type:'interrupted',turn_id:'reply-1'});""")
    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "debug_trace"
        and frame.get("name") == "voice_turn"
        and frame.get("data", {}).get("type") == "interrupted",
    )

    terminal = next(
        frame for frame in frames
        if frame.get("event") == "debug_trace"
        and frame.get("name") == "voice_turn"
        and frame.get("data", {}).get("type") == "interrupted"
    )
    assert terminal["data"] == {
        "type": "interrupted", "turn_id": "reply-1",
        "text": "Would you like to allow that?",
    }


async def test_background_status_tracks_the_deferred_task_not_unrelated_results(
    browser_page, browser_server,
):
    page, _ = browser_page
    server, _, frames = browser_server
    await open_session(page)

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 1,
        "action": "tool_deferred", "id": "task-1", "handle": "code-1",
        "status_label": "Pi",
    })
    await page.wait_for_function(
        "__fakeDialt.clients[0].bridgeCalls.some(call => call.action==='tool_deferred')",
    )
    assert not any(frame.get("seq") == 1 for frame in frames)
    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'tool_deferred_ack',id:'task-1',handle:'code-1',accepted:true,reason:null
    })""")
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 1)
    assert await page.locator("#status").inner_text() == "working"
    assert await page.evaluate("__fakeDialt.clients[0].toolChoices.at(-1)") == {
        "allowed": ["pi_request", "pi_cancel"],
    }
    assert await page.locator(".entry.activity").get_by_text(
        "Pi accepted in the background", exact=True,
    ).count() == 1

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 10,
        "action": "tool_result", "id": "approval-call-1",
        "content": {
            "control": "approval", "status": "applied", "decision": "allow_once",
            "pi_task_status": "running", "task_result_available": False,
        },
        "outcome": "succeeded", "verified": True,
    })
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 10)
    assert await page.locator("#status").inner_text() == "working"

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 2,
        "action": "tool_partial_result", "id": "task-1",
        "content": {
            "event": "pi_tool_started", "tool": "edit",
            "arguments": {"path": "app.py"},
        },
    })
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 2)
    assert await page.locator(".entry.activity").get_by_text("edit", exact=True).count() == 1

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 4,
        "action": "tool_result", "id": "task-1",
        "content": {"event": "pi_settled", "message": "Finished"},
        "outcome": "succeeded", "verified": True,
    })
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 4)
    assert await page.locator("#status").inner_text() == "listening"
    assert await page.evaluate("__fakeDialt.clients[0].toolChoices.at(-1)") == {
        "tool": "pi_request",
    }
    assert await page.locator(".entry.activity").get_by_text("Finished", exact=True).count() == 1
    calls = await page.evaluate("__fakeDialt.clients[0].bridgeCalls")
    result = next(
        call for call in calls
        if call.get("action") == "tool_result" and call.get("id") == "task-1"
    )
    assert result["options"] == {"outcome": "succeeded", "verified": True}


async def test_rejected_defer_ack_is_forwarded_without_marking_pi_working(
    browser_page, browser_server,
):
    page, _ = browser_page
    server, _, frames = browser_server
    await open_session(page)

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 1,
        "action": "tool_deferred", "id": "task-1", "handle": "code-1",
        "status_label": "Pi",
    })
    await page.wait_for_function(
        "__fakeDialt.clients[0].bridgeCalls.some(call => call.action==='tool_deferred')",
    )
    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'tool_deferred_ack',id:'task-1',accepted:false,reason:'handle_in_use'
    })""")
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 1)

    acknowledgement = next(frame for frame in frames if frame.get("seq") == 1)
    assert acknowledgement["detail"] == {
        "type": "tool_deferred_ack", "id": "task-1",
        "accepted": False, "reason": "handle_in_use",
    }
    assert await page.locator("#status").inner_text() == "listening"
    assert await page.locator(".entry.activity").get_by_text(
        "Pi background task rejected: handle_in_use", exact=True,
    ).count() == 1


async def test_activity_rows_distinguish_approval_and_unverified_pi_evidence(
    browser_page, browser_server,
):
    page, _ = browser_page
    server, _, frames = browser_server
    await open_session(page)

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 30,
        "action": "tool_partial_result", "id": "task-1",
        "interaction": {
            "prompt": "Allow Pi to run bash: pwd?",
            "options": ["Allow once", "Allow for this session", "Block"],
        },
        "content": {
            "event": "pi_approval_required", "approval_id": "approval-1",
            "tool": "bash", "summary": "pwd",
            "decisions": ["allow_once", "allow_session", "block"],
        },
    })
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 30)
    assert await page.locator(".entry.activity").get_by_text(
        "bash: pwd", exact=True,
    ).count() == 1
    assert await page.locator(".entry.activity").last.get_attribute("data-label") == (
        "Approval required"
    )

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 31,
        "action": "tool_result", "id": "task-1",
        "content": {
            "event": "pi_settled",
            "message": "Opened the airplane game in your default browser.",
        },
        "outcome": "succeeded", "verified": False,
    })
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 31)
    assert await page.locator(".entry.activity").last.inner_text() == (
        "Opened the airplane game in your default browser."
    )
    assert await page.locator(".entry.activity").last.get_attribute("data-label") == "Pi reported"


async def test_superseded_interaction_closes_without_completing_the_deferred_task(
    browser_page, browser_server,
):
    page, _ = browser_page
    server, _, frames = browser_server
    await open_session(page)

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 1,
        "action": "tool_deferred", "id": "task-1", "handle": "code-1",
        "status_label": "Pi",
    })
    await page.wait_for_function(
        "__fakeDialt.clients[0].bridgeCalls.some(call => call.action==='tool_deferred')",
    )
    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'tool_deferred_ack',id:'task-1',handle:'code-1',accepted:true,reason:null
    })""")
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 1)
    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 2,
        "action": "tool_partial_result", "id": "task-1",
        "content": {
            "event": "pi_approval_required", "approval_id": "approval-1",
            "tool": "bash", "summary": "open index.html",
            "decisions": ["allow_once", "allow_session", "block"],
        },
        "interaction": {
            "id": "approval-1",
            "prompt": "Allow Pi to run bash: open index.html?",
            "options": ["Allow once", "Allow for this session", "Block"],
            "resolver": {
                "tool": "pi_approval", "args": {"approval_id": "approval-1"},
                "option_args": {
                    "Allow once": {"decision": "allow_once"},
                    "Allow for this session": {"decision": "allow_session"},
                    "Block": {"decision": "block"},
                },
            },
        },
    })
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 2)

    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'tool_job_narration',state:'queued',job_ids:['task-1'],kind:'interaction'
    });
    __fakeDialt.clients[0].emit({
      type:'tool_job_narration',state:'started',job_ids:['task-1'],kind:'interaction'
    });
    __fakeDialt.clients[0].emit({type:'turn',turn_id:'ask-1'});
    __fakeDialt.clients[0].emit({
      type:'text_delta',delta:'Allow Pi to open index.html?',turn_id:'ask-1'
    });""")

    await page.evaluate("""__fakeDialt.clients[0].emit({type:'interrupted',turn_id:'ask-1'});
    __fakeDialt.clients[0].emit({
      type:'asr',text:'No, use a local server instead',final:true,turn_id:'user-2'
    });
    __fakeDialt.clients[0].emit({
      type:'tool_call',id:'message-2',name:'pi_request',
      args:{user_request:'Use a local server instead'}
    });""")
    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "tool_call"
        and frame.get("call", {}).get("id") == "message-2",
    )

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 3,
        "action": "tool_interaction_update", "id": "task-1",
        "interaction_id": "approval-1", "state": "superseded",
        "note": "The user changed course; the Pi approval was blocked.",
    })
    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 4,
        "action": "tool_result", "id": "message-2",
        "content": {
            "event": "pi_message_delivered", "mode": "steer", "task_status": "running",
        },
        "outcome": "succeeded", "verified": True,
    })
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 4)
    await page.evaluate("""__fakeDialt.clients[0].emit({
      type:'tool_job_narration',state:'superseded',job_ids:['task-1'],kind:'interaction'
    })""")

    assert await page.locator(".entry.activity").get_by_text(
        "The user changed course; the Pi approval was blocked.", exact=True,
    ).count() == 1
    assert await page.locator(".entry.activity").get_by_text(
        "Question narration interrupted", exact=True,
    ).count() == 1
    assert await page.locator("#status").inner_text() == "working"

    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 5,
        "action": "tool_result", "id": "task-1",
        "content": {"event": "pi_settled", "message": "Serving on localhost:8000"},
        "outcome": "succeeded", "verified": False,
    })
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 5)
    assert await page.locator("#status").inner_text() == "listening"

    calls = await page.evaluate("__fakeDialt.clients[0].bridgeCalls")
    task_events = [call["action"] for call in calls if call.get("id") == "task-1"]
    assert task_events == [
        "tool_deferred", "tool_partial_result", "tool_interaction_update", "tool_result",
    ]
    superseded = next(
        call for call in calls
        if call.get("action") == "tool_interaction_update"
    )
    assert superseded == {
        "action": "tool_interaction_update", "id": "task-1",
        "interactionId": "approval-1", "state": "superseded",
        "options": {"note": "The user changed course; the Pi approval was blocked."},
    }


async def test_sdk_cancellation_reaches_the_local_host(browser_page, browser_server):
    page, _ = browser_page
    _, _, frames = browser_server
    await open_session(page)
    await page.evaluate("__fakeDialt.clients[0].emit({type:'tool_cancel',id:'task-1'})")
    await wait_for_frame(
        frames,
        lambda frame: frame.get("event") == "tool_cancel"
        and frame.get("call", {}).get("id") == "task-1",
    )


async def test_unacknowledged_control_replays_after_sdk_reconnect(browser_page, browser_server):
    page, _ = browser_page
    server, _, frames = browser_server
    await open_session(page)
    await page.evaluate("__fakeDialt.transportLive=false")
    await server.send_json_to_tab({
        "type": "local", "event": "bridge_control", "seq": 9,
        "action": "tool_partial_result", "id": "task-1",
        "content": {"event": "pi_tool_started", "tool": "read", "arguments": {}},
    })
    await page.wait_for_timeout(50)
    assert not any(frame.get("seq") == 9 for frame in frames)
    await page.evaluate("__fakeDialt.transportLive=true;__fakeDialt.clients[0].emit({type:'reconnected'})")
    await wait_for_frame(frames, lambda frame: frame.get("seq") == 9)
    calls = await page.evaluate("__fakeDialt.clients[0].bridgeCalls")
    assert calls[-1] == {
        "action": "tool_partial_result", "id": "task-1",
        "content": {"event": "pi_tool_started", "tool": "read", "arguments": {}},
        "options": {},
    }
