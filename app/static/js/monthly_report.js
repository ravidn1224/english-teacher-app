'use strict';

(function () {
  function nisSigned(n) {
    n = Number(n) || 0;
    if (n < 0) return '−\u200e₪' + Math.abs(n);
    if (n > 0) return '+\u200e₪' + n;
    return '₪0';
  }

  function endBalancePhrase(endB) {
    var b = Number(endB) || 0;
    if (b < 0) return 'חוב \u200e₪' + Math.abs(b);
    if (b > 0) return 'זיכוי \u200e₪' + b;
    return '₪0';
  }

  function stepBalanceLine(endB) {
    var e = Number(endB) || 0;
    if (e < 0) return 'יתרה סוף חודש: חוב \u200e₪' + Math.abs(e);
    if (e > 0) return 'יתרה סוף חודש: זיכוי \u200e₪' + e;
    return 'יתרה סוף חודש: מאוזן';
  }

  function headerBadgeHtml(endB) {
    var b = Number(endB) || 0;
    if (b < 0) {
      return (
        '<span class="badge rounded-pill bg-danger-subtle text-danger border border-danger-subtle">חוב \u200e₪' +
        Math.abs(b) +
        '</span>'
      );
    }
    if (b > 0) {
      return (
        '<span class="badge rounded-pill bg-primary-subtle text-primary border border-primary-subtle">זיכוי \u200e₪' +
        b +
        '</span>'
      );
    }
    return (
      '<span class="badge rounded-pill bg-success-subtle text-success border border-success-subtle">' +
      '<i class="bi bi-check-lg me-1"></i>מאוזן</span>'
    );
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildDebtTrailHtml(trail) {
    if (!trail || !trail.length) return '';
    var rev = trail.slice().reverse();
    var chunks = [];
    for (var i = 0; i < rev.length; i++) {
      var step = rev[i];
      chunks.push(
        '<a href="/reports/?month=' +
          encodeURIComponent(step.month_key) +
          '" class="monthly-debt-trail__chip">' +
          '<span class="monthly-debt-trail__chip-month">' +
          escapeHtml(step.month_label_he) +
          '</span>' +
          '<span class="monthly-debt-trail__chip-lines small text-muted">' +
          stepBalanceLine(step.end_balance) +
          '</span></a>'
      );
      if (i < rev.length - 1) {
        chunks.push('<span class="monthly-debt-trail__arrow" aria-hidden="true">→</span>');
      }
    }
    return (
      '<div class="monthly-debt-trail">' +
      '<div class="monthly-debt-trail__title"><i class="bi bi-signpost-split me-2"></i>מעקב חוב — מאיפה הגיע?</div>' +
      '<div class="monthly-debt-trail__chips">' +
      chunks.join('') +
      '</div></div>'
    );
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setEndVisual(sum) {
    var wrap = document.getElementById('mr-val-end-wrap');
    var span = document.getElementById('mr-val-end');
    if (span) span.textContent = endBalancePhrase(sum);
    if (!wrap) return;
    wrap.classList.remove('text-danger', 'text-primary');
    var s = Number(sum) || 0;
    if (s < 0) wrap.classList.add('text-danger');
    else if (s > 0) wrap.classList.add('text-primary');
  }

  function applySummary(s) {
    setText('mr-val-lessons', String(s.lessons_done));
    setText('mr-val-fam-lessons', String(s.families_with_lessons));
    setText('mr-val-paid', '₪' + s.month_paid);
    setText('mr-val-charge-sub', String(s.month_charge));
    setEndVisual(s.end_balance_sum);
    setText('mr-val-indebt', String(s.families_in_debt_end));
  }

  function applyFilterCounts(fc) {
    document.querySelectorAll('.mr-tab-n').forEach(function (span) {
      var k = span.getAttribute('data-mr-tab');
      if (k && fc[k] != null) span.textContent = String(fc[k]);
    });
  }

  function applyFamilyCard(f) {
    var card = document.querySelector('[data-mr-family="' + f.id + '"]');
    if (!card) return false;
    card.setAttribute('data-monthly-family-filter', f.filter_class);
    card.className = 'monthly-family-card monthly-family-card--' + f.filter_class;
    var badge = card.querySelector('.mr-fam-header-badge');
    if (badge) badge.innerHTML = headerBadgeHtml(f.end_balance);
    var c1 = card.querySelector('.mr-fam-charge');
    if (c1) c1.textContent = '₪' + f.month_charge;
    var c2 = card.querySelector('.mr-fam-paid');
    if (c2) c2.textContent = '₪' + f.month_paid;
    var c3 = card.querySelector('.mr-fam-end');
    if (c3) {
      c3.textContent = nisSigned(f.end_balance);
      c3.classList.remove('text-danger', 'text-primary');
      if (f.end_balance < 0) c3.classList.add('text-danger');
      else if (f.end_balance > 0) c3.classList.add('text-primary');
    }
    var carryWrap = card.querySelector('[data-mr-carry-wrap]');
    if (carryWrap) {
      var co = Number(f.carry_over) || 0;
      if (co === 0) {
        carryWrap.classList.add('d-none');
      } else {
        carryWrap.classList.remove('d-none');
        var valEl = carryWrap.querySelector('.mr-fam-carry-val');
        if (valEl) {
          if (co < 0) valEl.textContent = 'חוב \u200e₪' + Math.abs(co);
          else if (co > 0) valEl.textContent = 'זיכוי \u200e₪' + co;
          else valEl.textContent = 'מאוזן';
        }
      }
    }
    var host = card.querySelector('.mr-debt-trail-host');
    if (host) {
      host.innerHTML = f.show_debt_trail ? buildDebtTrailHtml(f.debt_trail) : '';
    }
    (f.students || []).forEach(function (st) {
      if ((st.lesson_count || 0) < 1) return;
      var line = card.querySelector('.mr-st-line[data-mr-st="' + st.id + '"]');
      if (line) {
        line.innerHTML =
          '<span class="monthly-student-head__sep">·</span> חיוב \u200e₪' +
          st.charge_sum +
          '<span class="monthly-student-head__sep">·</span> שולם \u200e₪' +
          st.paid_sum +
          '<span class="monthly-student-head__sep">·</span> ' +
          st.lesson_count +
          ' שיעורים';
      }
    });
    return true;
  }

  function refilterVisible() {
    var active = document.querySelector('.monthly-filter-tab.active');
    var f = active ? active.getAttribute('data-monthly-filter') : 'all';
    var cards = document.querySelectorAll('[data-monthly-family-filter]');
    cards.forEach(function (card) {
      var c = card.getAttribute('data-monthly-family-filter');
      card.style.display = f === 'all' || f === c ? '' : 'none';
    });
  }

  function fetchAndApply() {
    var root = document.getElementById('mr-root');
    if (!root) return;
    var month = root.getAttribute('data-mr-month') || '';
    var btn = document.getElementById('mr-btn-refresh');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('disabled');
    }
    fetch('/reports/api/monthly-data?month=' + encodeURIComponent(month), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('refresh failed');
        return r.json();
      })
      .then(function (data) {
        applySummary(data.summary);
        applyFilterCounts(data.filter_counts);
        var domCards = document.querySelectorAll('[data-mr-family]');
        var payloadIds = {};
        data.families.forEach(function (f) {
          payloadIds[String(f.id)] = true;
        });
        var needReload = false;
        domCards.forEach(function (c) {
          var id = c.getAttribute('data-mr-family');
          if (!payloadIds[id]) needReload = true;
        });
        if (needReload || data.families.length !== domCards.length) {
          window.location.reload();
          return;
        }
        var missingApply = false;
        data.families.forEach(function (f) {
          if (!applyFamilyCard(f)) missingApply = true;
        });
        if (missingApply) {
          window.location.reload();
          return;
        }
        refilterVisible();
      })
      .catch(function () {
        window.location.reload();
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove('disabled');
        }
      });
  }

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

    var refreshBtn = document.getElementById('mr-btn-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', fetchAndApply);

    var lastMrFetch = 0;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || !document.getElementById('mr-root')) return;
      var now = Date.now();
      if (now - lastMrFetch < 5000) return;
      lastMrFetch = now;
      fetchAndApply();
    });
  });
})();
