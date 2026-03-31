'use strict';

document.addEventListener('DOMContentLoaded', function () {
  var tabs = document.querySelectorAll('[data-monthly-filter]');
  var cards = document.querySelectorAll('[data-monthly-family-filter]');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var f = tab.getAttribute('data-monthly-filter');
      tabs.forEach(function (t) {
        t.classList.toggle('active', t === tab);
      });
      cards.forEach(function (card) {
        var c = card.getAttribute('data-monthly-family-filter');
        card.style.display = f === 'all' || f === c ? '' : 'none';
      });
    });
  });

  document.querySelectorAll('.monthly-family-card__head').forEach(function (head) {
    var target = head.getAttribute('data-bs-target');
    if (!target) return;
    var el = document.querySelector(target);
    if (!el || typeof bootstrap === 'undefined') return;
    el.addEventListener('shown.bs.collapse', function () {
      head.classList.add('is-open');
    });
    el.addEventListener('hidden.bs.collapse', function () {
      head.classList.remove('is-open');
    });
  });

  document.querySelectorAll('.monthly-student-head').forEach(function (head) {
    var target = head.getAttribute('data-bs-target');
    if (!target) return;
    var el = document.querySelector(target);
    if (!el || typeof bootstrap === 'undefined') return;
    el.addEventListener('shown.bs.collapse', function () {
      head.classList.add('is-open');
    });
    el.addEventListener('hidden.bs.collapse', function () {
      head.classList.remove('is-open');
    });
  });
});
