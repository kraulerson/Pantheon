# Pantheon harness UAT session 5 — results (combined: runs 1–3)

- Date: 2026-10-16. Run 1 08:30–08:36 MDT (no browser); run 2 08:56–08:58 MDT (Chrome connected, not signed in); run 3 09:03–09:27 MDT (signed in to the harness; scenarios executed).
- Tester: agent (fable, on Karl's request)
- Build verified: `x-pantheon-build: 8cd3ce5` on `/harness/assets/harness.css` (curl, 08:30 and 08:57 MDT); page assets loaded as `…?b=8cd3ce5`; on-page header stamp reads "build 8cd3ce5" (grey, rgb(153,150,150), 13.5px, right edge x=1187 of 1200).
- Template export: SKIPPED — the Chrome extension refuses `file://` URLs ("Can't interact with browser-internal or unparseable URLs"), two attempts in run 2. Results live in this file.
- GIFs (copied into this directory; originals also in ~/Downloads): `uat5-sidebar-scenarios-1to6.gif` (46 frames, 4.8 MB), `uat5-terminal-scenarios-9to11.gif` (45 frames, 7.0 MB).
- Scratch terminal history: `uat5-scratch-pane-history.txt` (637 lines captured from the throwaway tmux pane before it was ended).
- tmux before run 3 (09:03:33): Dogfood, Maestro, cdf, homelab, lancache, solo. After run 3 (09:27:01): identical (`diff` empty). Attach counts unchanged (Dogfood 1, Maestro 2, cdf 10, homelab 12, lancache 9, solo 11). The agent created ONE throwaway session `uat5-scratch` through the harness sidebar and ended it with `exit` (no kill command); no live session was attached, typed into or signalled. Runs 1 and 2 also left the list unchanged.
- Clipboard: reset to `UAT5-RESET` before the first clipboard test; only marker comparisons were made (no raw paste printed); set to `UAT5-DONE` at the end.
- Keycard: ONE card minted, principal `uat5-card-5` (brief required a `uat5-` prefix; scenario text said `uat-card-5`), scope approvals:read only, 1 day; token never left the page (read in-page, used for in-page fetches, masked in the DOM, in-page stash cleared); revoked at the end and shown as "[x] Revoked".
- Nothing else created: no approvals, machines, registry entries, backends or settings. No code changed, nothing committed.

## Verdict counts

| Verdict | Count | Scenarios |
|---|---|---|
| PASS | 10 | 1, 2, 3, 4, 5, 11, 12, 15, 17, 18 |
| FAIL | 1 | 10 |
| BLOCKED | 1 | 13 |
| NEEDS-KARL | 4 | 6, 9, 14, 16 |
| NEEDS-KARL-EYES | 2 | 7, 8 |

## Per-scenario results

| id | title | verdict | evidence |
|---|---|---|---|
| 1 | Each machine folds and unfolds from its own arrow | PASS | Rows are native `<details class="machine">` with `<summary>` "[✓] Mac-Mini ready" / "[✓] Linux-Dev ready" (browser-drawn triangle + bracket + state word). Click on Mac-Mini's triangle: Mac-Mini `open:false`, Linux-Dev `open:true`, buttons hidden (screenshot); second click: Mac-Mini `open:true`. Only Mac-Mini changed. |
| 2 | Collapse all and Expand all work on the whole list | PASS | Press 1: both machines `open:false`, button label "Expand all". Press 2: both `open:true`, label "Collapse all". |
| 3 | The whole sidebar folds away to give the terminal the full width | PASS | With the uat5-scratch terminal connected: sidebar `display:flex` width 289 → after "☰ Machines" `display:none` width 0; terminal left edge x=294 → 5; xterm-screen width 882 → 1170 px; tmux status bar redrawn to the new right edge (screenshots). Second press restored 289 / 294 / 882. Header unchanged. |
| 4 | The harness remembers what you left folded | PASS | Folded Mac-Mini, hid sidebar (`localStorage["pantheon.sidebar"]` = "closed"), reloaded: sidebar still `display:none`; after unfolding the sidebar Mac-Mini `open:false`, Linux-Dev `open:true`. |
| 5 | A folded machine is not contacted until you open it | PASS | Network log for 13 s after reload with Mac-Mini folded: page + assets + `GET /harness/harness/tmux/Linux-Dev` only — no Mac-Mini request. Unfold: exactly one `GET /harness/harness/tmux/Mac-Mini` (200), body "[✓] 7 tmux session(s) on Mac-Mini:" with one button per session; the "[~] listing tmux sessions on Mac-Mini…" placeholder was present in the folded content and replaced too fast to screenshot. Fold + unfold again: request count unchanged (1), no "listing" text. |
| 6 | A machine that is not set up says why, and points at Configuration | NEEDS-KARL | No candidate: both registered machines are "[✓] ready" (sidebar) and "[✓] Provisioned [x] Enabled" (Configuration → Dev Machines). Agent may not add registry entries. Karl: register/disable a machine to test, or press Skip. |
| 7 | The terminal fills its tab and the text is clean while it scrolls | NEEDS-KARL-EYES | `seq 1 300` twice (tmux pane 98x38): final screens show lines 264–300 with a clean left column, output reaching the bottom row above the tmux bar, and a long line wrapping at the right edge (text reaches the right edge). Mid-scroll rendering was not observable frame-by-frame. The narrow-window pass was NOT done: the extension's resize_window reported success but the viewport stayed 1200x854 (two attempts). Reflow on width change was exercised via the sidebar toggle (882 ↔ 1170 px) instead. |
| 8 | Typing feels immediate, and the tab does not claim software rendering | NEEDS-KARL-EYES | Status line "[✓] connected to Mac-Mini · uat5-scratch"; `body.innerText` contains no "software rendering"; WebGL addon loaded (`.xterm canvas` present, xterm-addon-webgl.js served). A 118-character sentence typed by automation echoed completely and wrapped correctly. Perceived lag needs a human. |
| 9 | Selecting text copies it to your Mac clipboard | NEEDS-KARL | Could not perform an Option-drag: the automation tool does not hold Option during a drag, so the drag went to tmux's mouse mode (tmux buffer got the marker, Mac clipboard still held `UAT5-RESET`); a synthetic in-page alt-drag was also unreliable (stopped after two attempts). ⌘C needs an xterm selection, so not tested. Karl must do the Option-drag and ⌘C by hand. |
| 10 | A copy made inside tmux reaches your Mac clipboard | FAIL | Copy mode via keyboard in the harness terminal (Ctrl-b [, Up, C-a, C-Space, C-e, C-w = copy-pipe-and-cancel): tmux buffer == marker `UAT5-COPY-TMUX-9p2w7e`, Mac clipboard unchanged (`UAT5-RESET`). Same outcome for a tmux mouse-drag copy and for three CLI-driven copies in the scratch session (`copy-selection-and-cancel` ×2, `copy-pipe-and-cancel` ×1) and for `tmux set-buffer -w` to each client. Control: a shell-emitted `printf '\033]52;c;…'` DID reach the Mac clipboard (exact match), proving the harness→browser OSC 52 path works for selection field `c`; `52;s;…` and `52;;…` (empty field) were ignored. tmux config: `set-clipboard on`, client termfeatures include `clipboard`, tmux 3.6a. Inferred mechanism: tmux's own copies are emitted with an empty/non-`c` selection field, which the harness clipboard handling drops. |
| 11 | Ctrl+C still interrupts a running program | PASS | `ping 127.0.0.1` ran (5 packets), a drag across the output (plain drag — Option could not be held, see 9), then Ctrl+C: "^C", "--- 127.0.0.1 ping statistics ---", prompt back, tmux status back to `zsh` (screenshot + pane capture). |
| 12 | The Approvals page names which approval stores it checked | PASS | `/harness/admin/approvals`: "No pending approvals — nothing is waiting on you. Checked: Pantheon." No "[!]" store line. Only Pantheon → Alden's store not wired (expected per scenario). |
| 13 | A real waiting request appears as a reference line with its source | BLOCKED | Precondition missing: nothing pending and Alden's store is not among the checked sources ("Checked: Pantheon." only); page also states Approve/Reject arrive with M2 (read-only inbox). Agent may not create approvals. |
| 14 | Keycard door answers the same on both addresses (https) | NEEDS-KARL | Harness-host leg PASS: in-page `fetch` with the minted card to `https://pantheon.ferrumcorde.com/harness/keycard/v1/approvals` → 200 JSON, keys `["approvals","truncated"]`, `approvals` is an array (0 items), `truncated:false`, `redirected:false`. Admin-host leg could not be fetched from the page (cross-origin → TypeError/CORS) and curl would have put the token in the agent's context. Unauthenticated curl evidence (run 1): both hosts identical — no token 401 JSON `keycard_required`, bogus token 403 JSON `invalid_keycard`, no redirect/HTML; plain-http forms → 308 to https. Karl: one curl against pantheon-admin with a card. |
| 15 | Keycard refused on pages; revoke takes effect at once | PASS | Step 1: `GET /harness/admin/approvals` with the card (no cookies) → 403 JSON `{"error":"invalid_token"}`. Step 2: Revoke on Configuration → `?notice=keycard_revoked`. Step 3: door call with the same card → 403 JSON `{"error":"keycard_revoked"}` (checked on the harness-host door, see 14). Row now "uat5-card-5 approvals:read [x] Revoked … revoked 2026-10-16T15:25:06.612Z". |
| 16 | Chat page, harness and Configuration still work together | NEEDS-KARL | Chat page not signed in in Chrome: `https://pantheon.ferrumcorde.com/` → `/login` ("Welcome back", email/password), so the "Terminals" link could not be pressed; agent does not type credentials. Harness side verified: Configuration → `/harness/admin/config`, Help → `/harness/help` ("Pantheon Harness — User Guide"), Approvals → `/harness/admin/approvals`; sidebar Chat opens a "Chat" tab embedding `/` in an iframe (901x742, shows the LibreChat page). "+ New Session" dialog offers AI System "Claude CLI (terminal)" / "Alden-1 (chat)", an Identity field and Dev machine Mac-Mini / Linux-Dev; Start NOT pressed (it would create a live session; agent cancelled). Theme: harness `--surface-primary #0d0d0d`, `--text-primary #ececec`, `color-scheme: dark`; visual match with the chat page needs eyes. |
| 17 | The page says which build it is | PASS | Header stamp element text "build 8cd3ce5", grey rgb(153,150,150), 13.5px, right edge x=1187/1200; matches server header `x-pantheon-build: 8cd3ce5` and asset query `?b=8cd3ce5`. |
| 18 | Existing tmux sessions on the Mac are untouched | PASS | Before/after lists identical in all three runs (Dogfood, Maestro, cdf, homelab, lancache, solo); attach counts unchanged (1/2/10/12/9/11). The one throwaway session `uat5-scratch` was created via the harness and ended with `exit`; no residue (sidebar back to "6 tmux session(s)"). |

## Defect candidate (FAIL)

**Scenario 10 — tmux copies never reach the Mac clipboard through the harness.** Reproduced five ways inside the throwaway session (keyboard copy mode in the harness, tmux mouse-drag copy, CLI-driven `copy-selection-and-cancel`/`copy-pipe-and-cancel`, `tmux set-buffer -w`); in every case the tmux buffer held the marker and the Mac clipboard did not change. Control: an application-emitted OSC 52 with selection field `c` (`\033]52;c;<base64>\a`) reached the Mac clipboard at once, while `s` and the empty field were ignored. Inferred (not proven by reading tmux source): tmux emits its own OSC 52 with an empty selection field, and the harness's clipboard handling only honours `c`. One-line options to confirm: harness-side, treat an empty selection field as the clipboard; or tmux-side, force `c` with `set -as terminal-overrides ',xterm*:Ms=\E]52;c;%p2%s\007'`. Not implemented by the agent.

## Observations (not scenarios)

- After the page reload in scenario 4, the harness's first attach process for uat5-scratch (`tmux new-session -A -s uat5-scratch`, pid 5957, 130x39) stayed attached alongside the new one (`tmux attach-session -t =uat5-scratch`, 98x39) until the session ended — inferred: the client is not torn down when the browser tab goes away. The sidebar showed uat5-scratch as "attached elsewhere" throughout.
- "Refused keycard attempts: 4 (last 2026-10-16T14:32:58Z)" on Configuration are the agent's run-1 curl probes with a bogus token.
- Folded Linux-Dev content reads "[–] no tmux sessions on Linux-Dev" (consistent with `GET …/tmux/Linux-Dev` 200).

## Left for Karl

1. **Sign in to the chat page in Chrome** (https://pantheon.ferrumcorde.com/ shows "Welcome back"). Then **scenario 16**: press "Terminals" under the chat box (expect the harness under https://pantheon.ferrumcorde.com/harness/), then "Configuration", then "Help"; press "+ New Session", choose "Alden-1 (chat)" as the AI System, press Start; confirm the address stays under /harness/ and the pages use the chat page's colours and light/dark setting.
2. **Scenario 6**: there is no registered-but-unprovisioned machine. Either register one in Configuration → Dev Machines (or disable one) and check its row says "not provisioned"/"disabled" with a link to Configuration instead of a terminal button, or press Skip.
3. **Scenario 7, narrow pass**: attach to a scratch tmux session in the harness, make the browser window narrower, run `seq 1 300`, and watch that the left-hand columns stay clean while it scrolls and that nothing needs a resize to look right.
4. **Scenario 8, feel**: type a long sentence quickly in a harness terminal and judge whether characters keep up (the status line is already confirmed free of "software rendering").
5. **Scenario 9**: in a harness terminal, hold Option and drag across a sentence, release, paste into TextEdit (expect that exact text); then Option-drag a few words and press ⌘C, paste again (expect that text).
6. **Scenario 10 (FAIL)**: decide between the two one-line options above, or re-test after a fix: Ctrl-b [ , select, copy (C-w or M-w), paste outside the browser.
7. **Scenario 14, admin-host leg**: mint a card (approvals:read), in Terminal run
   ```
   CARD=PASTE_YOUR_pk1_CODE_HERE; curl -s -H "Authorization: Bearer $CARD" https://pantheon-admin.ferrumcorde.com/keycard/v1/approvals
   ```
   expect `{"approvals":[…],"truncated":false}`; then revoke the card. (The harness-host door, the 403 on a page and the revoke behaviour are already verified.)
8. **Scenario 13**: Skip — Alden's store is not wired ("Checked: Pantheon." only) and the inbox is read-only until M2.
9. Optional: look at the two GIFs in this directory for scenarios 1–6 and 9–11.

## Text evidence (folded in from the tester's files, 2026-10-16)

The tmux session lists captured before and after each run, and the throwaway pane's history. Kept inline so the submission is one Markdown file (the framework commit gate reads loose `.txt` files as source).

### tmux-before.txt

```
Dogfood
Maestro
cdf
homelab
lancache
solo
```

### tmux-after.txt

```
Dogfood
Maestro
cdf
homelab
lancache
solo
```

### tmux-before-run2.txt

```
Dogfood
Maestro
cdf
homelab
lancache
solo
```

### tmux-after-run2.txt

```
Dogfood
Maestro
cdf
homelab
lancache
solo
```

### tmux-before-run3.txt

```
Dogfood
Maestro
cdf
homelab
lancache
solo
```

### tmux-after-run3.txt

```
Dogfood
Maestro
cdf
homelab
lancache
solo
```

### uat5-scratch-pane-history.txt (637 lines)

```
karl@Karls-Mac-mini ~ %
karl@Karls-Mac-mini ~ %
karl@Karls-Mac-mini ~ %
karl@Karls-Mac-mini ~ %
karl@Karls-Mac-mini ~ % seq 1 300
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
37
38
39
40
41
42
43
44
45
46
47
48
49
50
51
52
53
54
55
56
57
58
59
60
61
62
63
64
65
66
67
68
69
70
71
72
73
74
75
76
77
78
79
80
81
82
83
84
85
86
87
88
89
90
91
92
93
94
95
96
97
98
99
100
101
102
103
104
105
106
107
108
109
110
111
112
113
114
115
116
117
118
119
120
121
122
123
124
125
126
127
128
129
130
131
132
133
134
135
136
137
138
139
140
141
142
143
144
145
146
147
148
149
150
151
152
153
154
155
156
157
158
159
160
161
162
163
164
165
166
167
168
169
170
171
172
173
174
175
176
177
178
179
180
181
182
183
184
185
186
187
188
189
190
191
192
193
194
195
196
197
198
199
200
201
202
203
204
205
206
207
208
209
210
211
212
213
214
215
216
217
218
219
220
221
222
223
224
225
226
227
228
229
230
231
232
233
234
235
236
237
238
239
240
241
242
243
244
245
246
247
248
249
250
251
252
253
254
255
256
257
258
259
260
261
262
263
264
265
266
267
268
269
270
271
272
273
274
275
276
277
278
279
280
281
282
283
284
285
286
287
288
289
290
291
292
293
294
295
296
297
298
299
300
karl@Karls-Mac-mini ~ % seq 1 300
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
37
38
39
40
41
42
43
44
45
46
47
48
49
50
51
52
53
54
55
56
57
58
59
60
61
62
63
64
65
66
67
68
69
70
71
72
73
74
75
76
77
78
79
80
81
82
83
84
85
86
87
88
89
90
91
92
93
94
95
96
97
98
99
100
101
102
103
104
105
106
107
108
109
110
111
112
113
114
115
116
117
118
119
120
121
122
123
124
125
126
127
128
129
130
131
132
133
134
135
136
137
138
139
140
141
142
143
144
145
146
147
148
149
150
151
152
153
154
155
156
157
158
159
160
161
162
163
164
165
166
167
168
169
170
171
172
173
174
175
176
177
178
179
180
181
182
183
184
185
186
187
188
189
190
191
192
193
194
195
196
197
198
199
200
201
202
203
204
205
206
207
208
209
210
211
212
213
214
215
216
217
218
219
220
221
222
223
224
225
226
227
228
229
230
231
232
233
234
235
236
237
238
239
240
241
242
243
244
245
246
247
248
249
250
251
252
253
254
255
256
257
258
259
260
261
262
263
264
265
266
267
268
269
270
271
272
273
274
275
276
277
278
279
280
281
282
283
284
285
286
287
288
289
290
291
292
293
294
295
296
297
298
299
300
karl@Karls-Mac-mini ~ % clear; echo UAT5-COPY-SEL-7f3k9q
UAT5-COPY-SEL-7f3k9q
karl@Karls-Mac-mini ~ % clear; echo UAT5-COPY-TMUX-9p2w7e
UAT5-COPY-TMUX-9p2w7e
karl@Karls-Mac-mini ~ % printf '\033]52;c;%s\a' "$(printf 'UAT5-OSC-DIRECT' | base64)"; echo osc-s
ent
osc-sent
karl@Karls-Mac-mini ~ % clear; echo UAT5-COPY-CLI-SEL-4h7n2s
UAT5-COPY-CLI-SEL-4h7n2s
karl@Karls-Mac-mini ~ % clear; echo UAT5-COPY-CLI-PIPE-8d3f1z
UAT5-COPY-CLI-PIPE-8d3f1z
karl@Karls-Mac-mini ~ % clear; echo UAT5-COPY-CLI-SEL2-5k9m3p
UAT5-COPY-CLI-SEL2-5k9m3p
karl@Karls-Mac-mini ~ % ping 127.0.0.1
PING 127.0.0.1 (127.0.0.1): 56 data bytes
64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.107 ms
64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.134 ms
64 bytes from 127.0.0.1: icmp_seq=2 ttl=64 time=0.191 ms
64 bytes from 127.0.0.1: icmp_seq=3 ttl=64 time=0.119 ms
64 bytes from 127.0.0.1: icmp_seq=4 ttl=64 time=0.201 ms
^C
--- 127.0.0.1 ping statistics ---
5 packets transmitted, 5 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 0.107/0.150/0.201/0.038 ms
karl@Karls-Mac-mini ~ % printf '\033]52;s;%s\a' "$(printf 'UAT5-OSC-SELS' | base64)"; echo osc-s-s
ent
osc-s-sent
karl@Karls-Mac-mini ~ % printf '\033]52;;%s\a' "$(printf 'UAT5-OSC-EMPTYSEL' | base64)"; echo osc-
empty-sent
osc-empty-sent
karl@Karls-Mac-mini ~ %
```
