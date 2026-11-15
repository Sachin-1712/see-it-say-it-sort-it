# Phase 1: camera and object inventory

Phase 2 now adds [permanent saved models and interactive previews](models.md).
The camera behavior below remains supported. Current model keys are `box_1`,
`box_2`, `box_3` and `sweeper`; confirming a capture opens its saved model preview.

The viewer now captures photographs into four fixed inventory slots: Box 1,
Box 2, Box 3 and Cylindrical Sweeper. Identity and box colour are **selected
manually**, not recognised by AI. This is the Phase 1 scope supplied after the
original PRD. Inventory capture is separate from the observer's physical-world
`items`; the original scene and WebSocket protocol are unchanged.

## Run locally

From the repository root, serve the entire repository (not just `viewer/`):

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://localhost:8080/viewer/> in a current Chrome, Firefox or Safari.
If the server is already running, refresh that page to load the changes.
Camera access requires HTTPS or a local secure context such as localhost, as
described in the [MediaDevices documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
An ordinary HTTP LAN IP will not provide webcam access. Upload remains available.

The observer is optional for capture. To run the existing fake demo in a second
terminal:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install websockets
.venv/bin/python scripts/fake_observer.py
```

It streams mock agents and parcel paths on `ws://localhost:8765`. It does not
run real physics or hardware. Killed mock agents remain dead until that process
restarts, as before this phase.

## Capture and test with the physical camera

1. Click **Capture Object** and allow the browser's camera request. If necessary,
   also allow the browser to use the camera in the OS privacy settings.
2. When **LIVE CAMERA** appears, hold one physical object in frame. If several
   cameras are connected, use the camera selector to choose the right one.
3. Click **Take Picture**. The frozen image is the actual video frame, labelled
   **CAMERA PHOTO**. Camera tracks are stopped at this point.
4. Click **Retake** to reopen the live camera, or select the object's identity and
   box colour. Red maps to Left Bag and blue to Right Bag using `config/rig.json`.
   Other colours show an unassigned destination unless configured in the rig.
5. Click **Add to Inventory**. Check the thumbnail, type, colour, destination and
   “Photo captured · saved model linked” status. Repeat for all four objects; progress reaches 4 of 4.
6. Use **Recapture** on a card to replace its photo. The existing photo stays until
   you confirm **Replace Photo in Inventory**. Canceling leaves the card intact.
   **Upload a photo** also works during recapture. **Remove** clears only that slot.
   You can edit a captured box's colour directly on its card.
7. Close the camera with **✕** or Escape while the preview is live. Verify the
   camera recording indicator turns off. Switching away from the tab pauses the
   camera too; use **Retry camera** to resume when you return.
8. Deny camera access or disconnect the webcam: an error should appear while
   **Upload a photo** remains available. Upload a real JPG, PNG or WebP photograph
   (maximum 20 MB), confirm its identity and check that the thumbnail matches.
9. Stop the fake observer. Repeat capture/upload; inventory stays usable. Existing
   observer controls disable on disconnection and reconnect when it returns.
10. With the observer running, use **Agents** and **Outcomes** to check the original
    controls and live scene. The inventory header remains available on either tab.

Browsers may remember a permission decision; a remembered grant will not show a
new permission prompt on every capture. Permissions and device availability are
controlled by the browser and operating system.

## Data and integration for the next phase

`viewer/inventory-store.mjs` owns exactly four records. A captured box looks like:

```json
{
  "id": "box_1",
  "type": "box",
  "name": "Box 1",
  "modelKey": "box_1",
  "color": "red",
  "destination": "left",
  "status": "captured",
  "capturedAt": "2026-11-14T23:00:00.000Z",
  "source": "camera"
}
```

The sweeper uses `id: "sweeper_1"`, `type: "sweeper"`,
`modelKey: "sweeper"`, and null colour and destination. `source` is
`camera` or `upload`; the timestamp records when the shot/upload was taken.
No image data is embedded in these JSON records.

The associated photograph is a JPEG Blob plus a temporary object URL, stored
separately under the same ID. Images are scaled to a maximum dimension of 1280
pixels. Blob URLs are revoked on replacement, removal or canceled drafts.
Neither photographs nor metadata are written to localStorage or sent to the
observer. This version intentionally keeps inventory **in memory for this tab**;
refreshing or closing the page clears it. There is no persistent storage or export.

Future modules can import the read-only API:

```js
import { inventory } from "./inventory.mjs";
const records = inventory.list(); // copies of JSON metadata
const photo = inventory.getPhoto("box_1"); // { blob, url } or null
document.addEventListener("inventorychange", event => {
  console.log(event.detail.records);
});
```

`modelKey` now selects the matching permanent asset described in [models.md](models.md).
A future recogniser can suggest identity/colour in the capture confirmation step.
Placement, stacking, simulation, new agents and Arduino integration remain future work.

## Automated checks

No frontend build or npm install is required to run the app. Development tests
use Node 22.22.2+, 24.15.0+, or 26+ and jsdom in the separate `tests/` directory:

```sh
npm ci --prefix tests
npm test --prefix tests
.venv/bin/python tests/observer_smoke.py
```

The Node suite checks four-slot isolation, record validation, colour mapping,
Blob URL cleanup, real-API call wiring, video-to-canvas capture, retake, upload,
permission errors, missing/busy cameras, device switching, disconnection,
close/visibility cleanup and canceled async requests. It uses **simulated media
devices and image encoding**, so it does not establish physical camera quality.
The Python smoke test exercises the unchanged observer commands over an isolated
WebSocket port and does not modify the running demo.

The native Chrome check during implementation verified the real camera preview,
an actual still frame, the confirmation screen, camera release after the shot,
and the existing rendered workshop and agent panel. Capturing the team's four
specific physical objects and testing other browsers remains a manual check.
