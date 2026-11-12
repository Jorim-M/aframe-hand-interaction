// ═══════════════════════════════════════════════════════════
// PINCH — decides, once per pinch, what it's for. Components that
// use pinches register their hand here and implement wantsPinch() /
// pinchStart() / pinchEnd(). In order:
//   1. a thumb tap on a curled index → nothing (it's the turning switch)
//   2. hand-teleport (which declines while the hand is at or
//      holding a grabbable)
// Emits 'pinchdecision' on the hand ({ owner, reason }).
// ═══════════════════════════════════════════════════════════
const PINCH_PRIORITY = ['hand-teleport'];

AFRAME.registerSystem('hand-pinch', {
  init: function () { this.hands = new Map(); },

  register: function (handEl, side) {
    if (this.hands.has(handEl)) return;
    const st = { side, owner: null };
    st.onStart = () => this.start(handEl, st);
    st.onEnd = () => this.end(st);
    handEl.addEventListener('pinchstarted', st.onStart);
    handEl.addEventListener('pinchended', st.onEnd);
    this.hands.set(handEl, st);
  },

  start: function (handEl, st) {
    if (st.owner) return;
    const input = this.el.systems['hand-input'];
    if (input && input.isThumbTap(input.get(st.side))) {
      handEl.emit('pinchdecision', { owner: null, reason: 'thumb tap' });
      return;
    }
    for (const name of PINCH_PRIORITY) {
      const c = handEl.components[name];
      if (c && c.wantsPinch()) {
        st.owner = c;
        c.pinchStart();
        handEl.emit('pinchdecision', { owner: name, reason: '' });
        return;
      }
    }
    handEl.emit('pinchdecision', { owner: null, reason: 'nothing wants it' });
  },

  end: function (st) {
    const o = st.owner;
    st.owner = null;
    if (o) o.pinchEnd();
  }
});
