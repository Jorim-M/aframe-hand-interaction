// ═══════════════════════════════════════════════════════════
// HIGHLIGHT — shared emissive tint for hovered / touched objects.
// Counts requests per material, so two hands (or pointer + poke)
// on the same object never leave it stuck tinted.
// ═══════════════════════════════════════════════════════════
AFRAME.registerSystem('hand-highlight', {
  init: function () {
    this.saved = new Map(); // material → { orig: Color, count }
    this._tint = new THREE.Color();
  },

  set: function (el, color, on) {
    if (!el || !el.object3D) return;
    if (on) this._tint.set(color);
    el.object3D.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m.emissive) continue; // e.g. unlit materials: no highlight
        let s = this.saved.get(m);
        if (on) {
          if (!s) { s = { orig: m.emissive.clone(), count: 0 }; this.saved.set(m, s); }
          s.count++;
          m.emissive.copy(s.orig).add(this._tint);
        } else if (s) {
          s.count--;
          if (s.count <= 0) { m.emissive.copy(s.orig); this.saved.delete(m); }
        }
      }
    });
  }
});
