# Camera and object inventory

The current demo is documented in [Models, inventory and interactive workbench](models.md).
Capture remains browser-native with a real webcam or image upload. Identity is
selected manually: **Box**, **Cylindrical Sweeper**, or **Other object · approximation**.
The photograph never triggers regeneration of a known object's permanent asset.

## Run

Serve the repository root:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://localhost:8080/viewer/>. Camera access requires a supported browser
on a secure context such as localhost or HTTPS, as explained in the
[MediaDevices documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
The mock observer is optional for capture, preview and placement.

## Capture checklist

1. Click **Capture Object** and allow camera access. The browser/OS may remember
   previous permission decisions; a new prompt is not required on every opening.
2. Wait for **LIVE CAMERA** and centre the object. Choose a connected webcam using
   the camera selector when several devices are present.
3. Click **Take Picture**. The confirmation shows the actual video frame and
   stops the stream. **Retake** reopens the camera.
4. Choose the identity and, for Box, its routing colour. Red maps to Left Bag and
   blue to Right Bag via `config/rig.json`. Model surfaces stay neutral grey.
5. For Other, name the object and choose an approximate shape and measured
   width/depth/height. The UI states this is an approximation, not reconstruction.
6. Confirm **Add to Inventory**. The photo-to-model transition runs in the inventory
   preview. Click the card to place an instance in the workshop.
7. **Recapture** keeps the old photograph until confirmation; **Remove** clears
   that inventory record only. Existing placed instances stay on the bench.
8. Close using ✕ or Escape while previewing: the camera must stop. Hiding the tab
   pauses live capture too; **Retry camera** resumes it.
9. Deny permission, disconnect the camera or use an unavailable device: the error
   should leave **Upload a photo** usable. Accepted formats: JPG, PNG, WebP, up to
   20 MB. Corrupt uploads cannot accidentally confirm an older pending draft.
10. Stop the observer and repeat the flow; it must remain usable. Agent controls
    reconnect separately when the observer returns.

## Storage and integration

Each capture stores JSON metadata (`id`, `type`, `name`, `modelKey`, `color`,
`destination`, `generation`, `status`, `capturedAt`, `source`) separately from its
JPEG Blob and temporary URL. Images are resized to at most 1280 pixels on their
longest edge. No base64 photos go into localStorage; no photograph is sent to the
observer. Refreshing/closing the tab clears inventory and world placement.

Known IDs/model keys are `box` and `sweeper`; unfamiliar captures receive unique
`unknown_###` IDs with `procedural:unknown_###` keys and a `definition` containing
an explicitly approximate shape and dimensions. There is no fixed four-slot limit.

```js
import { inventory } from './inventory.mjs';
inventory.list();         // independent metadata snapshots
inventory.get('box');
inventory.getPhoto('box'); // { blob, url } or null
// document events: inventorychange, inventorypreview
```

The captured inventory is separate from the observer's physical-world `items`
array and the workbench's placed instances. `inventory-store.mjs` has no WebGL or
WebSocket dependency. Async camera grants, image decoding and canvas encoding are
guarded so canceled or superseded work cannot resurrect a capture or leave a
camera stream running. Blob URLs are released on replacement/removal/cancel.

## Tests

```sh
npm ci --prefix tests
npm test --prefix tests
```

DOM tests use simulated cameras/encoders and do not establish physical camera
quality. Native Chrome was also checked with an actual webcam, retained photograph,
confirmation, particle transition, inventory and workbench placement. Other
browser/device combinations remain manual checks.
