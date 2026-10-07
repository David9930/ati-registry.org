(function () {
  var q = document.getElementById('q'), lab = document.getElementById('lab'), st = document.getElementById('stat');
  var rows = [].slice.call(document.querySelectorAll('#rows tr'));
  var count = document.getElementById('count'), empty = document.getElementById('empty');
  if (!q) return;
  q.form.addEventListener('submit', function (e) { e.preventDefault(); });
  function norm(s) { return s.toLowerCase().replace(/[\s\-]+/g, ' ').trim(); }
  function run() {
    var t = norm(q.value), l = lab.value, s = st.value, n = 0;
    rows.forEach(function (r) {
      var ok = (!t || r.getAttribute('data-s').indexOf(t) > -1) && (!l || r.getAttribute('data-l') === l) && (!s || r.getAttribute('data-st') === s);
      r.hidden = !ok; if (ok) n++;
    });
    count.textContent = n + ' of ' + rows.length + ' shown';
    empty.hidden = n > 0 || rows.length === 0 ? true : false;
    if (rows.length && n === 0) empty.hidden = false;
  }
  ['input', 'change'].forEach(function (e) { q.addEventListener(e, run); lab.addEventListener(e, run); st.addEventListener(e, run); });
  var p = new URLSearchParams(location.search); if (p.get('q')) q.value = p.get('q');
  run();
})();
