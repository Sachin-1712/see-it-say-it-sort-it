// ---------------------------------------------------------------------------
// The ONLY place the simulation's z-up table frame becomes three.js y-up.
// Table frame: x right, y away from the front edge, z up (mm, degrees CCW from above).
// three.js:    X = x, Y = z, Z = -y. A CCW rotation about z is the same rotation about Y.
// Every other module (scene, workbench, model fitting) goes through these two.
export function toThree({ x = 0, y = 0, z = 0 }) {
  return [x, z, -y];
}
// Inverse, used only to report measured scene geometry back in table-frame mm.
export function fromThree([X, Y, Z]) {
  return { x: X, y: -Z, z: Y };
}
// ---------------------------------------------------------------------------
