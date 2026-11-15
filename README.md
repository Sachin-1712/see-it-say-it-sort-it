# Dry Run

A DurHack parcel-sorting viewer with camera capture, an object inventory and four
permanent Blender-generated GLB models.

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://localhost:8080/viewer/>. Click **Capture Object** to photograph
Box 1, Box 2, Box 3 or the Cylindrical Sweeper, or upload a photograph. Identity
and colour are selected manually. Confirming a photo loads the matching saved
model with rotate/zoom/reset controls. Inventory photos clear on refresh; the
saved assets remain in the repository.

See [saved model generation and preview instructions](docs/models.md) for
Blender commands, measurements, pivots, units, physical metadata and validation.

See [camera and inventory instructions](docs/camera-inventory.md) for webcam
testing, optional mock observer setup, the data format and automated checks.
The original project plan is in [docs/PRD.md](docs/PRD.md).
