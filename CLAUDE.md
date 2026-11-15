

Read docs/STATE.md and docs/PRD.md before any work.
Sachin owns the viewer and the MuJoCo simulation (sim/).
Joe owns agents, observer and Arduino firmware; do not build those.
Do not change the WebSocket frame format without updating
docs/viewer-frame.md and telling the team.
Units are millimetres and degrees, z-up. Convert to three.js y-up in
toThree() only, and to metres only inside sim/.
Viewer: static page, three.js from a CDN, no build step.