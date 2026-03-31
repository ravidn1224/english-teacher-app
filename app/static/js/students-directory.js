(function () {
  var root = document.getElementById("studentsDirectoryList");
  var input = document.getElementById("studentDirectorySearch");
  var emptyEl = document.getElementById("studentsSearchEmpty");
  if (!root || !input) return;

  function digitsOnly(s) {
    return String(s).replace(/\D/g, "");
  }

  function applyFilter() {
    var q = input.value.trim().toLowerCase();
    var qDigits = digitsOnly(q);
    var sections = root.querySelectorAll("section[data-student-search]");
    var visible = 0;
    sections.forEach(function (sec) {
      var hay = (sec.getAttribute("data-student-search") || "").toLowerCase();
      var show =
        !q ||
        hay.indexOf(q) !== -1 ||
        (qDigits.length >= 2 && hay.indexOf(qDigits) !== -1);
      sec.classList.toggle("d-none", !show);
      if (show) visible += 1;
    });
    if (emptyEl) {
      var showEmpty = sections.length > 0 && visible === 0;
      emptyEl.classList.toggle("d-none", !showEmpty);
    }
  }

  input.addEventListener("input", applyFilter);
  input.addEventListener("search", applyFilter);
})();
