import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const event = (type, payload) => ({ protocol:"zer0.room", version:1, sessionId:"chat-test", eventSeq:"1", eventId:"event-1", turnId:"turn-1", occurredAt:"2026-01-01T00:00:00Z", type, payload });
const request = (id=1) => ({jsonrpc:"2.0",id,method:"test",params:{}});
const LF = Buffer.from([0x0a]);
const framed = (value) => Buffer.concat([Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), LF]);
const cases = [
 ["frame-exact-limit", Buffer.concat([Buffer.from(JSON.stringify(request())),Buffer.alloc(1_048_576-1-Buffer.byteLength(JSON.stringify(request())),0x20),LF]), "frame", true, "maximum total frame is accepted"],
 ["frame-over-limit", Buffer.concat([Buffer.from(JSON.stringify(request())),Buffer.alloc(1_048_577-1-Buffer.byteLength(JSON.stringify(request())),0x20),LF]), "frame", false, "frame including LF exceeds cap"],
 ["invalid-utf8", Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0xff,0x7d,0x0a]), "frame", false, "strict UTF-8 rejects replacement decoding"],
 ["string-id", framed(request("id")), "request", true, "string ID"], ["max-safe-id", framed(request(9007199254740991)), "request", true, "safe numeric ID"], ["unsafe-id", framed(request(9007199254740992)), "request", false, "unsafe numeric ID"], ["fractional-id", framed(request(1.5)), "request", false, "fractional numeric ID"], ["request-extra", framed({...request(),extra:true}), "request", false, "unknown request field"],
 ["notification-extra", framed({jsonrpc:"2.0",method:"zer0/room/event",params:event("backend.failed",{}),extra:true}), "notification", false, "unknown notification field"], ["success-null", framed('{"jsonrpc":"2.0","id":"r","result":null}'), "response", true, "generic null success"], ["missing-result", framed('{"jsonrpc":"2.0","id":"r"}'), "response", false, "success requires result"], ["both-result-error", framed('{"jsonrpc":"2.0","id":"r","result":null,"error":{"code":1,"message":"x"}}'), "response", false, "response has both arms"],
 ["chunk-ascii-max", Buffer.from(JSON.stringify(event("lane.chunk",{laneId:"l",streamId:"s",agent:"codex",streamSeq:"1",chunkIndex:0,channel:"stdout",text:"x".repeat(32768)}))+"\\n"), "event", true, "32KiB ASCII"],
 ["chunk-ascii-over", Buffer.from(JSON.stringify(event("lane.chunk",{laneId:"l",streamId:"s",agent:"codex",streamSeq:"1",chunkIndex:0,channel:"stdout",text:"x".repeat(32769)}))+"\\n"), "event", false, "chunk text too large"],
 ["chunk-emoji-max", Buffer.from(JSON.stringify(event("lane.chunk",{laneId:"l",streamId:"s",agent:"codex",streamSeq:"1",chunkIndex:0,channel:"stdout",text:"😀".repeat(8192)}))+"\\n"), "event", true, "32KiB emoji"],
 ["chunk-emoji-over", Buffer.from(JSON.stringify(event("lane.chunk",{laneId:"l",streamId:"s",agent:"codex",streamSeq:"1",chunkIndex:0,channel:"stdout",text:"😀".repeat(8193)}))+"\\n"), "event", false, "emoji bytes too large"],
 ["chunk-index-max", Buffer.from(JSON.stringify(event("lane.chunk",{laneId:"l",streamId:"s",agent:"codex",streamSeq:"1",chunkIndex:9007199254740991,channel:"stdout",text:"x"}))+"\\n"), "event", true, "safe chunk index"],
 ["chunk-index-over", Buffer.from(JSON.stringify(event("lane.chunk",{laneId:"l",streamId:"s",agent:"codex",streamSeq:"1",chunkIndex:9007199254740992,channel:"stdout",text:"x"}))+"\\n"), "event", false, "unsafe chunk index"],
 ["activity-known", Buffer.from(JSON.stringify(event("lane.activity",{laneId:"l",streamId:"s",toolCallId:"t",update:"tool_call"}))+"\\n"), "event", true, "known activity"],
 ["activity-unknown", Buffer.from(JSON.stringify(event("lane.activity",{laneId:"l",streamId:"s",toolCallId:"t",update:"other"}))+"\\n"), "event", false, "unknown wire activity"],
 ["agent-status-valid", framed(event("agent.status",{agent:"codex",auth:"limited",usage:{exhausted:false,contextUsedPct:42,fiveHourUsedPct:71,fiveHourResetsAtMs:9007199254740991,weeklyUsedPct:81},availability:{state:"retrying",resetsAtMs:0}})), "event", true, "bounded provider status snapshot"],
 ["agent-status-empty", framed(event("agent.status",{agent:"codex"})), "event", false, "status requires at least one reported channel"],
 ["agent-status-percent-over", framed(event("agent.status",{agent:"codex",usage:{exhausted:false,contextUsedPct:101}})), "event", false, "usage percentages are bounded"],
 ["agent-status-fractional", framed(event("agent.status",{agent:"codex",usage:{exhausted:false,fiveHourUsedPct:1.5}})), "event", false, "usage percentages are integers"],
 ["agent-status-unsafe-reset", framed(event("agent.status",{agent:"codex",availability:{state:"exhausted",resetsAtMs:9007199254740992}})), "event", false, "status reset timestamps are safe integers"],
 ["agent-status-unknown", framed(event("agent.status",{agent:"codex",auth:"ready",sample:{secret:"must-not-cross"}})), "event", false, "raw diagnostic samples never enter room status"],
 ["agent-mode-valid", framed(event("agent.mode",{agent:"codex",modeId:"agent",word:"careful",status:"active",availableModeIds:["read-only","agent","agent-full-access"]})), "event", true, "bounded native mode state"],
 ["agent-mode-unknown", framed(event("agent.mode",{agent:"codex",modeId:"agent",status:"active",sample:"must-not-cross"})), "event", false, "mode state rejects unknown fields"],
 ["hop-max-valid", framed(event("hop.dispatched",{fromAgent:"claude",toAgent:"codex",parentMessageId:"msg-parent",hopIndex:1,maxHop:1,hopId:"hop-1",text:"review this"})), "event", true, "strict modern hop payload"],
 ["hop-both-budget-names", framed(event("hop.dispatched",{fromAgent:"claude",toAgent:"codex",parentMessageId:"msg-parent",hopIndex:1,maxHop:1,hopBudget:1,hopId:"hop-1",text:"review this"})), "event", false, "hop budget field is unambiguous"],
 ["event-invalid-calendar-date", framed({...event("turn.completed",{}),occurredAt:"2026-02-30T00:00:00Z"}), "event", false, "calendar dates are RFC3339-valid in every runtime"],
 ...[["backend-empty",{},true],["backend-message",{message:"x"},true],["backend-error",{error:"x"},true],["backend-unknown",{other:"x"},false],["backend-empty-field",{message:""},false]].map(([id,p,ok])=>[id,Buffer.from(JSON.stringify(event("backend.failed",p))+"\\n"),"event",ok,"backend.failed shape"]),
 ["notice-valid", framed(event("room.notice",{cause:"memory-compose-failed",agent:"claude",detail:"SQLITE_CORRUPT: briefing composition failed"})), "event", true, "room.notice shape"],
 // VALID on purpose: an older terminal reading a newer host renders an unrecognized cause with a generic phrase rather than rejecting the event and losing the row. The closed cause set is enforced at the host's emission site, not on the wire.
 ["notice-unknown-cause", framed(event("room.notice",{cause:"some-future-condition",detail:"from a newer host"})), "event", true, "unknown room.notice cause still validates"],
 ["notice-missing-detail", framed(event("room.notice",{cause:"memory-compose-failed"})), "event", false, "room.notice requires detail"],
 ["notice-detail-over", framed(event("room.notice",{cause:"memory-compose-failed",detail:"x".repeat(201)})), "event", false, "room.notice detail exceeds 200 code points"],
 ["notice-detail-max", framed(event("room.notice",{cause:"memory-compose-failed",detail:"\u{1f600}".repeat(200)})), "event", true, "200 astral code points is exactly the bound"],
 ["resync-null",Buffer.from('{"jsonrpc":"2.0","id":"room-resync-1","result":null}\\n'),"trace",false,"resync result null is not {events:[...]}"],
 ["trace-identical-duplicate", Buffer.concat([framed(event("backend.failed",{})),framed(event("backend.failed",{}))]), "trace", true, "identical replay duplicate is a reducer no-op", [{"line":1,"expect":"apply"},{"line":2,"expect":"no-op"}]],
 ["trace-conflicting-duplicate", Buffer.concat([framed(event("backend.failed",{})),framed(event("backend.failed",{message:"changed"}))]), "trace", false, "same eventId with differing content is fatal", [{"line":1,"expect":"apply"},{"line":2,"expect":"fatal-conflict"}]],
 ["trace-gap-resync-repeat", Buffer.concat([framed(event("backend.failed",{})),framed({...event("backend.failed",{}),eventSeq:"3",eventId:"event-3"}),framed({...event("backend.failed",{}),eventSeq:"2",eventId:"event-2"}),framed({...event("backend.failed",{}),eventSeq:"3",eventId:"event-3"})]), "trace", true, "global gap buffers event and replay repeats it once", [{"line":1,"expect":"apply"},{"line":2,"expect":"request-resync-after-1-buffer"},{"line":3,"expect":"apply"},{"line":4,"expect":"merge-once-live"}]],
];
await mkdir(dir,{recursive:true});
const out=[]; for (const [id,source,kind,valid,reason,steps] of cases) { const bytes = source.at(-2) === 0x5c && source.at(-1) ===0x6e ? Buffer.concat([source.subarray(0, -2), LF]) : source; const file=`${id}.bin`; await writeFile(join(dir,file),bytes); out.push({id,file,kind,byteLength:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),expect:{valid,reason,...(steps === undefined ? {} : {steps})}}); }
await writeFile(join(dir,"manifest.json"),JSON.stringify({formatVersion:1,protocol:"zer0.room",version:1,limits:{frameBytesIncludingLf:1048576,chunkTextUtf8Bytes:32768,maxSafeInteger:9007199254740991},cases:out},null,2)+"\n");
