/* Мой заработок — серверная часть (Google Apps Script API). Файл генерируется сборкой. */

/* ===== Расчётное ядро (общее с интерфейсом) ===== */
/* ===== Расчётное ядро. Все деньги — целые копейки, время — целые минуты. ===== */
(function (root) {
  'use strict';

  // Округление до целого «половина вверх» с защитой от ошибок двоичной дроби
  function rnd(x) {
    if (!isFinite(x)) return 0;
    var s = x < 0 ? -1 : 1;
    return s * Math.round(Math.abs(x) + 1e-7);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function parseTime(t) {
    if (typeof t !== 'string') return null;
    var m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  // Длительность смены: окончание − начало − перерыв, с переходом через полночь
  function shiftSpan(start, end) {
    var s = parseTime(start), e = parseTime(end);
    if (s === null || e === null) return null;
    var span = e - s;
    if (span <= 0) span += 1440; // окончание после полуночи
    return span;
  }

  function shiftMinutes(start, end, breakMin) {
    var span = shiftSpan(start, end);
    if (span === null) return { ok: false, error: 'Укажите время в формате ЧЧ:ММ' };
    var b = Math.max(0, Math.round(+breakMin || 0));
    if (b >= span) return { ok: false, error: 'Перерыв не может быть равен или больше длительности смены' };
    return { ok: true, span: span, total: span - b, crossesMidnight: (parseTime(end) <= parseTime(start)) };
  }

  // Разделение на обычные и праздничные минуты
  function splitMinutes(shift) {
    var total = shift.totalMin | 0;
    var hol = 0;
    if (shift.type === 'holiday') hol = total;
    else if (shift.type === 'partial') hol = Math.min(total, Math.max(0, shift.holidayMin | 0));
    return { regular: total - hol, holiday: hol, total: total };
  }

  // Подсказка: сколько минут смены приходится на праздничные даты (перерыв вычитается из обычной части)
  function suggestHolidayMinutes(date, start, end, breakMin, holidaySet) {
    var sm = shiftMinutes(start, end, breakMin);
    if (!sm.ok) return null;
    var s = parseTime(start);
    var firstDayLeft = Math.min(sm.span, 1440 - s);
    var secondDay = sm.span - firstDayLeft;
    var d2 = addDays(date, 1);
    var holRaw = (holidaySet[date] ? firstDayLeft : 0) + (holidaySet[d2] ? secondDay : 0);
    if (holRaw === 0) return { type: 'regular', holidayMin: 0 };
    if (holRaw >= sm.span) return { type: 'holiday', holidayMin: sm.total };
    var hol = Math.min(holRaw, sm.total);
    return { type: 'partial', holidayMin: hol };
  }

  // ===== Даты =====
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromISO(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(iso, n) { var d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d); }
  function daysInMonth(month) { var p = month.split('-'); return new Date(+p[0], +p[1], 0).getDate(); }
  function monthOf(iso) { return iso.slice(0, 7); }
  function addMonths(month, n) {
    var p = month.split('-'); var d = new Date(+p[0], +p[1] - 1 + n, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  function periodOf(iso, splitDay) {
    var day = +iso.slice(8, 10);
    return { month: monthOf(iso), half: day <= splitDay ? 1 : 2 };
  }
  function periodRange(month, half, splitDay) {
    var last = daysInMonth(month);
    var sd = Math.min(splitDay, last - 1);
    return half === 1
      ? { from: month + '-01', to: month + '-' + pad(sd) }
      : { from: month + '-' + pad(sd + 1), to: month + '-' + pad(last) };
  }
  function periodKey(month, half) { return month + '-' + half; }

  // Значение из истории на дату: последняя запись с from <= date; если раньше всех — самая ранняя
  function valueAt(history, iso) {
    if (!history || !history.length) return null;
    var sorted = history.slice().sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : (a.createdAt || 0) - (b.createdAt || 0); });
    var v = sorted[0].value;
    for (var i = 0; i < sorted.length; i++) { if (sorted[i].from <= iso) v = sorted[i].value; }
    return v;
  }

  // ===== Статусы смен =====
  // В заработок попадает только смена со статусом «Отработана» (done).
  // Старые записи без статуса считаются отработанными: сервер один раз проставляет им статус по времени.
  function shiftStartMs(s) { var p = s.date.split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0).getTime() + (parseTime(s.start) || 0) * 60000; }
  function shiftEndMs(s) { return shiftStartMs(s) + (shiftSpan(s.start, s.end) || 0) * 60000; }
  function isWorked(s) { return !s.status || s.status === 'done'; }
  // Для отображения: done, inprogress (идёт сейчас), awaiting (закончилась, но не подтверждена), planned
  function shiftState(s, now) {
    if (isWorked(s)) return 'done';
    now = now == null ? Date.now() : now;
    if (now >= shiftEndMs(s)) return 'awaiting';
    if (s.status === 'inprogress' || now >= shiftStartMs(s)) return 'inprogress';
    return 'planned';
  }
  function defaultStatus(s, now) { now = now == null ? Date.now() : now; return now >= shiftEndMs(s) ? 'done' : now >= shiftStartMs(s) ? 'inprogress' : 'planned'; }

  // ===== Деньги смены =====
  function shiftPay(shift) {
    var sp = splitMinutes(shift);
    var rate = shift.rate | 0, coef = +shift.coef || 0;
    var reg = rnd(sp.regular * rate / 60);
    var hol = rnd(sp.holiday * rate * coef / 60);
    return { regularMin: sp.regular, holidayMin: sp.holiday, totalMin: sp.total, regularPay: reg, holidayPay: hol, total: reg + hol };
  }

  function upsellReward(amountKop, mode, value) {
    if (mode === 'fixed') return rnd(+value || 0);           // value — копейки
    if (mode === 'percent') return rnd((amountKop | 0) * (+value || 0) / 100);
    return 0;
  }

  var COUNTED = { confirmed: 1, accrued: 1 };

  // ===== Период (половина месяца) =====
  function computePeriod(state, month, half) {
    var st = state.settings;
    var splitDay = st.splitDay || 15;
    var upsellHalf = 2; // апселлы месяца целиком входят во вторую половину, в первую — никогда
    var range = periodRange(month, half, splitDay);
    var key = periodKey(month, half);
    var pinfo = (state.periods && state.periods[key]) || {};

    // Группировка по (ставка, коэффициент): часы × ставка, как в формуле
    var groups = {};
    var shifts = [], worked = [], plannedMin = 0, plannedCount = 0, plannedPay = 0;
    (state.shifts || []).forEach(function (s) {
      if (s.date >= range.from && s.date <= range.to) {
        shifts.push(s);
        if (!isWorked(s)) { plannedCount++; plannedMin += s.totalMin | 0; plannedPay += shiftPay(s).total; return; }
        worked.push(s);
        var sp = splitMinutes(s);
        var g = s.rate + '|' + s.coef;
        if (!groups[g]) groups[g] = { rate: s.rate | 0, coef: +s.coef, reg: 0, hol: 0 };
        groups[g].reg += sp.regular; groups[g].hol += sp.holiday;
      }
    });
    var regularMin = 0, holidayMin = 0, regularPay = 0, holidayPay = 0;
    var rateLines = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var rp = rnd(g.reg * g.rate / 60), hp = rnd(g.hol * g.rate * g.coef / 60);
      regularMin += g.reg; holidayMin += g.hol; regularPay += rp; holidayPay += hp;
      rateLines.push({ rate: g.rate, coef: g.coef, regularMin: g.reg, holidayMin: g.hol, regularPay: rp, holidayPay: hp });
    });
    var base = regularPay + holidayPay;

    var upsConfirmed = 0, upsPending = 0, upsCountConfirmed = 0, upsCountPending = 0, upsCancelled = 0;
    var upsells = [];
    if (half === upsellHalf) {
      (state.upsells || []).forEach(function (u) {
        if ((u.payMonth || monthOf(u.date)) !== month) return;
        upsells.push(u);
        if (COUNTED[u.status]) { upsConfirmed += u.reward | 0; upsCountConfirmed++; }
        else if (u.status === 'pending') { upsPending += u.reward | 0; upsCountPending++; }
        else if (u.status === 'cancelled') upsCancelled++;
      });
    }
    var accrued = base + upsConfirmed;

    var taxSource = 'history';
    var taxRate;
    if (pinfo.closed && pinfo.taxRateSnap != null) { taxRate = +pinfo.taxRateSnap; taxSource = 'closed'; }
    else if (pinfo.taxRateOverride != null && pinfo.taxRateOverride !== '') { taxRate = +pinfo.taxRateOverride; taxSource = 'override'; }
    else taxRate = +(valueAt(st.taxRates, range.to) || 0);
    var taxCalc = rnd(accrued * taxRate / 100);
    var manual = pinfo.taxManual != null && pinfo.taxManual !== '';
    var tax = manual ? (pinfo.taxManual | 0) : taxCalc;
    var net = accrued - tax;

    return {
      key: key, month: month, half: half, from: range.from, to: range.to,
      closed: !!pinfo.closed, shifts: shifts, workedShifts: worked, shiftCount: worked.length,
      plannedCount: plannedCount, plannedMin: plannedMin, plannedPay: plannedPay,
      regularMin: regularMin, holidayMin: holidayMin, totalMin: regularMin + holidayMin,
      regularPay: regularPay, holidayPay: holidayPay, base: base, rateLines: rateLines,
      includesUpsells: half === upsellHalf, upsells: upsells,
      upsConfirmed: upsConfirmed, upsPending: upsPending, upsCountConfirmed: upsCountConfirmed,
      upsCountPending: upsCountPending, upsCancelled: upsCancelled,
      accrued: accrued, taxRate: taxRate, taxSource: taxSource, taxCalc: taxCalc,
      taxManual: manual, tax: tax, net: net
    };
  }

  function computeMonth(state, month) {
    var p1 = computePeriod(state, month, 1), p2 = computePeriod(state, month, 2);
    var keys = ['regularMin', 'holidayMin', 'totalMin', 'regularPay', 'holidayPay', 'base', 'upsConfirmed', 'upsPending',
      'upsCountConfirmed', 'upsCountPending', 'accrued', 'tax', 'shiftCount', 'plannedCount', 'plannedMin', 'plannedPay'];
    var t = { month: month, p1: p1, p2: p2 };
    keys.forEach(function (k) { t[k] = p1[k] + p2[k]; });
    t.net = t.accrued - t.tax; // налог вычитается один раз
    return t;
  }

  // ===== Выплаты =====
  function paymentSummary(state, month, half) {
    var p = computePeriod(state, month, half);
    var received = 0, list = [];
    (state.payments || []).forEach(function (x) {
      if (x.month === month && (+x.half) === half) { received += x.amount | 0; list.push(x); }
    });
    var diff = received - p.net; // >0 переплата, <0 остаток
    var status;
    if (p.net <= 0 && received === 0) status = 'none';
    else if (received === 0) status = 'unpaid';
    else if (diff < 0) status = 'partial';
    else if (diff === 0) status = 'paid';
    else status = 'over';
    return { key: p.key, month: month, half: half, expected: p.net, received: received, diff: diff, status: status, payments: list, period: p };
  }

  var api = {
    rnd: rnd, parseTime: parseTime, shiftSpan: shiftSpan, shiftMinutes: shiftMinutes, splitMinutes: splitMinutes,
    suggestHolidayMinutes: suggestHolidayMinutes, toISO: toISO, fromISO: fromISO, addDays: addDays,
    daysInMonth: daysInMonth, monthOf: monthOf, addMonths: addMonths, periodOf: periodOf, periodRange: periodRange,
    periodKey: periodKey, valueAt: valueAt, shiftPay: shiftPay, upsellReward: upsellReward,
    computePeriod: computePeriod, shiftStartMs: shiftStartMs, shiftEndMs: shiftEndMs, isWorked: isWorked, shiftState: shiftState, defaultStatus: defaultStatus, computeMonth: computeMonth, paymentSummary: paymentSummary, pad: pad
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(this);

/* ===================== «Мой заработок» — сервер Google Apps Script ===================== */
/* Хранилище — листы этой таблицы. Деньги в листах в рублях, внутри — в копейках.        */

var APP_TITLE = 'Мой заработок';
var BACKUP_FOLDER = 'Мой заработок — резервные копии';
var EXPORT_FOLDER = 'Мой заработок — экспорт';
var SCHEMA_VERSION = '4';
var KEEP_AUTO_BACKUPS = 30;

var SHIFT_STATUS_RU = { planned: 'Запланирована', inprogress: 'В процессе', done: 'Отработана' };
var TYPE_RU = { regular: 'Обычная', holiday: 'Праздничная', partial: 'Разделена вручную' };
var STATUS_RU = { pending: 'Ожидает подтверждения', confirmed: 'Подтверждён', accrued: 'Начислен', cancelled: 'Отменён' };
var MODE_RU = { percent: 'Процент от суммы', fixed: 'Фиксированная сумма' };
var PAY_RU = { none: 'Нет начислений', unpaid: 'Не выплачено', partial: 'Выплачено частично', paid: 'Выплачено', over: 'Переплата' };

function col(key, title, kind, opt) { var c = { key: key, title: title, kind: kind }; if (opt) for (var k in opt) c[k] = opt[k]; return c; }
function rub(k) { return Math.round(k) / 100; }

var SCHEMA = {
  shifts: { sheet: 'Рабочие смены', width: 110, cols: [
    col('id', 'ID', 'text', { w: 90 }), col('date', 'Дата', 'text'), col('start', 'Начало', 'text', { w: 70 }), col('end', 'Окончание', 'text', { w: 80 }),
    col('breakMin', 'Перерыв, мин', 'int'), col('totalMin', 'Отработано, мин', 'int'), col('type', 'Тип', 'enum', { map: TYPE_RU, w: 140 }),
    col('holidayMin', 'Праздничные, мин', 'int'), col('rate', 'Ставка, ₽/ч', 'money'), col('coef', 'Коэффициент', 'num'),
    col('_h', 'Отработано, ч', 'num', { calc: function (o) { return o.totalMin / 60; }, fmt: '0.00' }),
    col('_rh', 'Обычные, ч', 'num', { calc: function (o) { return Engine.shiftPay(o).regularMin / 60; }, fmt: '0.00' }),
    col('_hh', 'Праздничные, ч', 'num', { calc: function (o) { return Engine.shiftPay(o).holidayMin / 60; }, fmt: '0.00' }),
    col('_rp', 'Оплата обычных, ₽', 'money', { calc: function (o) { return Engine.shiftPay(o).regularPay; } }),
    col('_hp', 'Оплата праздничных, ₽', 'money', { calc: function (o) { return Engine.shiftPay(o).holidayPay; } }),
    col('_tp', 'Итого за смену, ₽', 'money', { calc: function (o) { return Engine.shiftPay(o).total; } }),
    col('comment', 'Комментарий', 'text', { w: 220 }), col('createdAt', 'Создано', 'ts'), col('updatedAt', 'Изменено', 'ts'),
    // новые колонки добавлены в конец — старые строки остаются на своих местах
    col('status', 'Статус смены', 'enum', { map: SHIFT_STATUS_RU, w: 130 }), col('plannedStart', 'План: начало', 'text', { w: 90 }), col('plannedEnd', 'План: окончание', 'text', { w: 100 }),
    col('plannedBreakMin', 'План: перерыв, мин', 'int'), col('confirmedAt', 'Подтверждена', 'ts')] },
  upsells: { sheet: 'Апселлы', width: 120, cols: [
    col('id', 'ID', 'text', { w: 90 }), col('booking', 'Номер бронирования', 'text', { w: 150 }), col('date', 'Дата апселла', 'text'), col('payMonth', 'В зарплате за месяц', 'text'),
    col('categoryId', 'ID категории', 'text', { w: 90 }), col('categoryName', 'Тип апселла', 'text', { w: 170 }), col('amount', 'Сумма апселла, ₽', 'money'),
    col('ruleMode', 'Правило', 'enum', { map: MODE_RU, w: 150 }), col('ruleValue', 'Значение правила (% или ₽)', 'rule'), col('reward', 'Вознаграждение, ₽', 'money'),
    col('rewardManual', 'Вознаграждение вручную', 'bool'), col('status', 'Статус', 'enum', { map: STATUS_RU, w: 170 }),
    col('_in', 'Входит в зарплату', 'text', { calc: function (o) { return (o.status === 'confirmed' || o.status === 'accrued') ? 'да' : 'нет'; } }),
    col('roomFrom', 'Исходная категория номера', 'text', { w: 150 }), col('roomTo', 'Новая категория номера', 'text', { w: 150 }),
    col('checkIn', 'Заезд', 'text'), col('checkOut', 'Выезд', 'text'), col('comment', 'Комментарий', 'text', { w: 220 }),
    col('createdAt', 'Создано', 'ts'), col('updatedAt', 'Изменено', 'ts')] },
  payments: { sheet: 'История выплат', width: 130, cols: [
    col('id', 'ID', 'text', { w: 90 }), col('receivedDate', 'Дата получения', 'text'), col('month', 'Расчётный месяц', 'text'), col('half', 'Половина месяца', 'int'),
    col('amount', 'Получено, ₽', 'money'), col('comment', 'Комментарий', 'text', { w: 220 }), col('createdAt', 'Создано', 'ts'), col('updatedAt', 'Изменено', 'ts')] },
  hourlyRates: { sheet: 'История почасовых ставок', width: 140, cols: [col('id', 'ID', 'text', { w: 90 }), col('from', 'Действует с', 'text'), col('value', 'Ставка, ₽/ч', 'money'), col('createdAt', 'Добавлено', 'ts')] },
  taxRates: { sheet: 'История налоговых ставок', width: 140, cols: [col('id', 'ID', 'text', { w: 90 }), col('from', 'Действует с', 'text'), col('value', 'Ставка налога, %', 'num'), col('createdAt', 'Добавлено', 'ts')] },
  holidayCoefs: { sheet: 'История коэффициентов', width: 140, cols: [col('id', 'ID', 'text', { w: 90 }), col('from', 'Действует с', 'text'), col('value', 'Праздничный коэффициент', 'num'), col('createdAt', 'Добавлено', 'ts')] },
  categories: { sheet: 'Категории апселлов', width: 140, cols: [col('id', 'ID', 'text', { w: 90 }), col('name', 'Название', 'text', { w: 200 }), col('mode', 'Способ начисления', 'enum', { map: MODE_RU, w: 160 }),
    col('value', 'Значение (% или ₽)', 'rule'), col('active', 'Активна', 'bool'), col('createdAt', 'Создано', 'ts'), col('updatedAt', 'Изменено', 'ts')] },
  holidays: { sheet: 'Праздничные дни', width: 120, cols: [col('date', 'Дата', 'text')] },
  periods: { sheet: 'Расчёты зарплаты', width: 115, cols: [
    col('key', 'Период', 'text'), col('month', 'Месяц', 'text'), col('halfName', 'Половина', 'text', { w: 130 }), col('from', 'С', 'text'), col('to', 'По', 'text'),
    col('regularH', 'Обычные, ч', 'num', { fmt: '0.00' }), col('holidayH', 'Праздничные, ч', 'num', { fmt: '0.00' }), col('regularPay', 'Обычная оплата, ₽', 'money'), col('holidayPay', 'Праздничная оплата, ₽', 'money'),
    col('base', 'Базовая зарплата, ₽', 'money'), col('upsConfirmed', 'Апселлы в расчёте, ₽', 'money'), col('upsPending', 'Апселлы ожидают, ₽', 'money'), col('accrued', 'Начислено, ₽', 'money'),
    col('taxRate', 'Ставка налога, %', 'num'), col('tax', 'Налог, ₽', 'money'), col('net', 'На руки, ₽', 'money'), col('received', 'Получено, ₽', 'money'), col('diff', 'Остаток (−) / переплата (+), ₽', 'money'),
    col('payStatus', 'Статус выплаты', 'text', { w: 150 }), col('closed', 'Период закрыт', 'bool'), col('closedAt', 'Закрыт', 'ts'),
    col('taxRateSnap', 'Зафиксированная ставка, %', 'num'), col('taxRateOverride', 'Ставка для периода, %', 'num'), col('taxManual', 'Фактический налог вручную, ₽', 'money'), col('updatedAt', 'Пересчитано', 'ts')] },
  log: { sheet: 'История изменений', width: 160, cols: [col('at', 'Время', 'ts'), col('text', 'Действие', 'text', { w: 620 })] }
};
var SETTINGS_SHEET = 'Настройки';
var SETTINGS_KEYS = [
  ['displayName', 'Имя в приветствии', 'text'], ['currency', 'Валюта (код ISO)', 'text'], ['splitDay', 'Последний день первой половины месяца', 'int'],
  ['upsellHalf', 'Половина месяца для апселлов (1 или 2)', 'int'], ['autoBackup', 'Ежедневная резервная копия', 'bool'], ['lastBackupAt', 'Последняя резервная копия', 'ts'],
  ['version', 'Версия данных', 'int'], ['createdAt', 'Создано', 'ts'], ['updatedAt', 'Изменено', 'ts']];
var SHEET_ORDER = ['shifts', 'upsells', SETTINGS_SHEET, 'hourlyRates', 'taxRates', 'payments', 'periods', 'log', 'categories', 'holidayCoefs', 'holidays'];

/* ---------- Web App ---------- */
function doGet() {
  return HtmlService.createHtmlOutput('<div style="font-family:-apple-system,sans-serif;padding:32px;max-width:520px;line-height:1.5">' +
    '<h2 style="font-weight:500">«Мой заработок» — сервер</h2><p>Это адрес API. Приложение открывается со страницы GitHub Pages; там введите этот адрес и секретный ключ.</p></div>')
    .setTitle(APP_TITLE).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- API для приложения на GitHub Pages ---------- */
// Запрос: POST, тело — JSON { key, fn, args }. Ответ: { ok: true, result } или { ok: false, error }.
var API_ = {
  getAll: getAll_, getRev: getRev_, apply: apply_, exportAll: exportAll_, backupNow: backupNow_, setAutoBackup: setAutoBackup_,
  backupInfo: backupInfo_, restoreAll: restoreAll_, saveToDrive: saveToDrive_, recalcNow: recalcNow_,
  ping: function () { return 'ok'; }
};
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function sameKey_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var d = 0; for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var key = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (!key) return json_({ ok: false, error: 'no_key', message: 'Ключ ещё не создан. В редакторе Apps Script выполните функцию createApiKey.' });
    if (!sameKey_(String(req.key || ''), key)) { Utilities.sleep(800); return json_({ ok: false, error: 'unauthorized', message: 'Неверный ключ доступа' }); }
    var fn = API_[req.fn];
    if (!fn) return json_({ ok: false, error: 'bad_request', message: 'Неизвестная операция' });
    ensureSheets_();
    return json_({ ok: true, result: fn.apply(null, req.args || []) });
  } catch (err) {
    return json_({ ok: false, error: 'server', message: String((err && err.message) || err) });
  }
}

/* ---------- Ключ доступа (только из редактора, владельцем) ---------- */
function ownerOnly_() {
  var a = Session.getActiveUser().getEmail(), me = Session.getEffectiveUser().getEmail();
  if (!a || a !== me) throw new Error('Эту функцию может запустить только владелец в редакторе Apps Script');
}
function createApiKey() {
  ownerOnly_();
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    props.setProperty('API_KEY', key);
  }
  console.log('Ключ доступа: ' + key);
  return key;
}
function rotateApiKey() {
  ownerOnly_();
  PropertiesService.getScriptProperties().deleteProperty('API_KEY');
  appendLog_([{ at: Date.now(), text: 'Ключ доступа заменён — старый больше не работает' }]);
  return createApiKey();
}

/* ---------- Конвертация строк ---------- */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function fmtOf_(c) {
  if (c.fmt) return c.fmt;
  if (c.kind === 'text' || c.kind === 'enum') return '@';
  if (c.kind === 'money') return '#,##0.00';
  if (c.kind === 'int') return '0';
  if (c.kind === 'ts') return 'dd.MM.yyyy HH:mm:ss';
  if (c.kind === 'num' || c.kind === 'rule') return '0.###';
  return 'General';
}
function toCell_(c, o) {
  var v = c.calc ? c.calc(o) : o[c.key];
  if (v === undefined || v === null || v === '') return '';
  switch (c.kind) {
    case 'money': return rub(v);
    case 'int': return Math.round(+v);
    case 'num': return +v;
    case 'bool': return !!v;
    case 'ts': return new Date(+v);
    case 'enum': return c.map[v] || String(v);
    case 'rule': return o[c.key === 'ruleValue' ? 'ruleMode' : 'mode'] === 'fixed' ? rub(v) : +v;
    default: return String(v);
  }
}
function fromCell_(c, v, o) {
  if (v === '' || v === null || v === undefined) return c.kind === 'bool' ? false : (c.kind === 'text' || c.kind === 'enum') ? '' : null;
  switch (c.kind) {
    case 'money': return Math.round(+v * 100);
    case 'int': return Math.round(+v);
    case 'num': return +v;
    case 'bool': return v === true || v === 'TRUE' || v === 'да' || v === 1;
    case 'ts': return v instanceof Date ? v.getTime() : (+v || null);
    case 'enum': for (var k in c.map) if (c.map[k] === v || k === v) return k; return String(v);
    case 'rule': return +v; // режим учитывается после чтения строки
    default: return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v);
  }
}
function sheetOf_(kind) { return ss_().getSheetByName(SCHEMA[kind].sheet); }
function readKind_(kind) {
  var sc = SCHEMA[kind], sh = sheetOf_(kind), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var vals = sh.getRange(2, 1, n, sc.cols.length).getValues();
  var out = [];
  vals.forEach(function (row) {
    if (row.every(function (v) { return v === '' || v === null; })) return;
    var o = {};
    sc.cols.forEach(function (c, i) { if (!c.calc) o[c.key] = fromCell_(c, row[i], o); });
    if (o.ruleMode === 'fixed' && o.ruleValue != null) o.ruleValue = Math.round(o.ruleValue * 100);
    if (kind === 'categories' && o.mode === 'fixed' && o.value != null) o.value = Math.round(o.value * 100);
    out.push(o);
  });
  return out;
}
function rowOf_(kind, o) { return SCHEMA[kind].cols.map(function (c) { return toCell_(c, o); }); }
function fmtRow_(kind) { return SCHEMA[kind].cols.map(fmtOf_); }
function writeAll_(kind, list) {
  var sc = SCHEMA[kind], sh = sheetOf_(kind), last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sc.cols.length).clearContent();
  if (!list.length) return;
  var rows = list.map(function (o) { return rowOf_(kind, o); });
  var f = fmtRow_(kind), fm = rows.map(function () { return f; });
  var r = sh.getRange(2, 1, rows.length, sc.cols.length);
  r.setNumberFormats(fm); r.setValues(rows);
}
function findRow_(kind, id) {
  var sh = sheetOf_(kind), n = sh.getLastRow() - 1; if (n < 1) return -1;
  var ids = sh.getRange(2, 1, n, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}
function putRow_(kind, o) {
  var sh = sheetOf_(kind), cols = SCHEMA[kind].cols.length, r = findRow_(kind, o.id);
  if (r < 0) r = sh.getLastRow() + 1;
  var rg = sh.getRange(r, 1, 1, cols);
  rg.setNumberFormats([fmtRow_(kind)]); rg.setValues([rowOf_(kind, o)]);
}
function delRow_(kind, id) { var r = findRow_(kind, id); if (r > 0) sheetOf_(kind).deleteRow(r); }

/* ---------- Настройки (ключ — значение) ---------- */
function readSettingsKV_() {
  var sh = ss_().getSheetByName(SETTINGS_SHEET), n = sh.getLastRow() - 1, o = {};
  if (n < 1) return o;
  var map = {}; SETTINGS_KEYS.forEach(function (k) { map[k[0]] = k; });
  sh.getRange(2, 1, n, 2).getValues().forEach(function (r) {
    var k = String(r[0]); if (!map[k]) return;
    o[k] = fromCell_({ kind: map[k][2] }, r[1]);
  });
  return o;
}
function writeSettingsKV_(o) {
  var sh = ss_().getSheetByName(SETTINGS_SHEET);
  var rows = SETTINGS_KEYS.map(function (k) { return [k[0], toCell_({ key: k[0], kind: k[2] }, o), k[1]]; });
  var fm = SETTINGS_KEYS.map(function (k) { return ['@', fmtOf_({ kind: k[2] }), '@']; });
  var last = sh.getLastRow(); if (last > 1) sh.getRange(2, 1, last - 1, 3).clearContent();
  var r = sh.getRange(2, 1, rows.length, 3); r.setNumberFormats(fm); r.setValues(rows);
}

/* ---------- Создание структуры ---------- */
function ensureSheets_() {
  var props = PropertiesService.getScriptProperties();
  var ss = ss_(), have = {};
  ss.getSheets().forEach(function (s) { have[s.getName()] = 1; });
  var complete = have[SETTINGS_SHEET] && Object.keys(SCHEMA).every(function (k) { return have[SCHEMA[k].sheet]; });
  if (complete && props.getProperty('schema') === SCHEMA_VERSION) return;
  SHEET_ORDER.forEach(function (k, idx) {
    var isSettings = k === SETTINGS_SHEET;
    var name = isSettings ? SETTINGS_SHEET : SCHEMA[k].sheet;
    var head = isSettings ? ['Ключ', 'Значение', 'Описание'] : SCHEMA[k].cols.map(function (c) { return c.title; });
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name, idx);
    var hr = sh.getRange(1, 1, 1, head.length);
    hr.setValues([head]).setFontWeight('bold').setBackground('#1E4A37').setFontColor('#FBF8F1').setWrap(true).setVerticalAlignment('middle');
    sh.setFrozenRows(1);
    if (isSettings) { sh.setColumnWidth(1, 140); sh.setColumnWidth(2, 220); sh.setColumnWidth(3, 320); }
    else SCHEMA[k].cols.forEach(function (c, i) { sh.setColumnWidth(i + 1, c.w || SCHEMA[k].width); });
    if (!isSettings && k !== 'log' && k !== 'holidays') sh.hideColumns(1);
  });
  ['Лист1', 'Sheet1'].forEach(function (n) { var s = ss.getSheetByName(n); if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s); });
  props.setProperty('schema', SCHEMA_VERSION);
}

/* ---------- Чтение всего ---------- */
function loadState_() {
  var kv = readSettingsKV_();
  var settings = null;
  var hourly = readKind_('hourlyRates');
  if (hourly.length) {
    settings = {
      version: kv.version || 1, displayName: kv.displayName || '', currency: kv.currency || 'RUB', splitDay: kv.splitDay || 15, upsellHalf: kv.upsellHalf || 2,
      autoBackup: !!kv.autoBackup, lastBackupAt: kv.lastBackupAt || null, createdAt: kv.createdAt || null, updatedAt: kv.updatedAt || null,
      hourlyRates: hourly, holidayCoefs: readKind_('holidayCoefs'), taxRates: readKind_('taxRates'), categories: readKind_('categories'),
      holidays: readKind_('holidays').map(function (h) { return h.date; }).filter(String).sort()
    };
    if (!settings.holidayCoefs.length) settings.holidayCoefs = [{ id: 'coef-default', from: '2000-01-01', value: 2, createdAt: Date.now() }];
    if (!settings.taxRates.length) settings.taxRates = [{ id: 'tax-default', from: '2000-01-01', value: 13, createdAt: Date.now() }];
  }
  var periods = {};
  readKind_('periods').forEach(function (p) {
    var m = {}; if (p.closed) m.closed = true;
    if (p.closedAt) m.closedAt = p.closedAt;
    if (p.taxRateSnap != null) m.taxRateSnap = p.taxRateSnap;
    if (p.taxRateOverride != null) m.taxRateOverride = p.taxRateOverride;
    if (p.taxManual != null) m.taxManual = p.taxManual;
    if (Object.keys(m).length) periods[p.key] = m;
  });
  return { settings: settings, periods: periods, shifts: readKind_('shifts'), upsells: readKind_('upsells'), payments: readKind_('payments') };
}
function readLog_(limit) {
  var sh = sheetOf_('log'), n = sh.getLastRow() - 1; if (n < 1) return [];
  var take = Math.min(n, limit || 300), vals = sh.getRange(n + 2 - take, 1, take, 2).getValues();
  return vals.map(function (r) { return { at: r[0] instanceof Date ? r[0].getTime() : +r[0], text: String(r[1]) }; }).reverse();
}
function rev_() { return Number(PropertiesService.getScriptProperties().getProperty('rev') || 0); }
function bump_() { var r = rev_() + 1; PropertiesService.getScriptProperties().setProperty('rev', String(r)); return r; }

function getAll_() {
  ensureSheets_();
  migrateShiftStatuses_();
  var st = loadState_();
  st.log = readLog_(300);
  st.rev = rev_();
  st.meta = { email: Session.getActiveUser().getEmail(), spreadsheetUrl: ss_().getUrl(), tz: Session.getScriptTimeZone(), serverTime: Date.now() };
  return JSON.stringify(st); // строка: google.script.run надёжно передаёт её без потерь
}
function getRev_() { return rev_(); }

/* ---------- Миграция: статусы старых смен ---------- */
// Один раз: прошедшие смены без статуса — «Отработана» (история сохраняется), будущие — «Запланирована».
function migrateShiftStatuses_() {
  var list = readKind_('shifts').filter(function (x) { return !x.status; });
  if (!list.length) return;
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var now = Date.now(), done = 0, planned = 0;
    readKind_('shifts').forEach(function (x) {
      if (x.status) return;
      x.status = now >= Engine.shiftEndMs(x) ? 'done' : 'planned';
      if (x.status === 'done') done++; else planned++;
      putRow_('shifts', x);
    });
    appendLog_([{ at: now, text: 'Статусы смен проставлены автоматически: отработано ' + done + ', запланировано ' + planned }]);
    recalc_(); bump_();
  } finally { lock.releaseLock(); }
}

/* ---------- Изменения ---------- */
var ITEM_KINDS = { shifts: 1, upsells: 1, payments: 1 };
function apply_(opsJson) {
  var ops = typeof opsJson === 'string' ? JSON.parse(opsJson) : opsJson;
  ensureSheets_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var logRows = [];
    ops.forEach(function (op) {
      if (op.op === 'put') { if (!ITEM_KINDS[op.kind]) throw new Error('kind'); validateItem_(op.kind, op.item); putRow_(op.kind, op.item); }
      else if (op.op === 'del') { if (!ITEM_KINDS[op.kind]) throw new Error('kind'); delRow_(op.kind, op.id); }
      else if (op.op === 'settings') writeSettings_(op.settings);
      else if (op.op === 'periods') writePeriodsMeta_(op.map);
      else if (op.op === 'log') logRows.push({ at: op.at || Date.now(), text: String(op.text).slice(0, 500) });
    });
    if (logRows.length) appendLog_(logRows);
    recalc_();
    var r = bump_();
    return r;
  } finally { lock.releaseLock(); }
}
function validateItem_(kind, o) {
  if (!o || !o.id || !/^[A-Za-z0-9-]{4,64}$/.test(o.id)) throw new Error('Некорректный идентификатор записи');
  var isoRe = /^\d{4}-\d{2}-\d{2}$/;
  if (kind === 'shifts') {
    if (!isoRe.test(o.date)) throw new Error('Некорректная дата смены');
    var sm = Engine.shiftMinutes(o.start, o.end, o.breakMin);
    if (!sm.ok) throw new Error(sm.error);
    if (sm.total !== o.totalMin) throw new Error('Часы смены не совпадают с расчётом');
    if (o.holidayMin < 0 || o.holidayMin > o.totalMin) throw new Error('Праздничных часов больше, чем часов в смене');
    if (o.status && !SHIFT_STATUS_RU[o.status]) throw new Error('Неизвестный статус смены');
  }
  if (kind === 'upsells' && (!o.booking || !isoRe.test(o.date))) throw new Error('Нужны номер бронирования и дата апселла');
  if (kind === 'payments' && (!isoRe.test(o.receivedDate) || !(o.amount > 0))) throw new Error('Нужны дата и сумма выплаты');
}
function writeSettings_(s) {
  var old = readSettingsKV_();
  writeSettingsKV_({ displayName: s.displayName, currency: s.currency, splitDay: s.splitDay, upsellHalf: s.upsellHalf, autoBackup: !!s.autoBackup,
    lastBackupAt: old.lastBackupAt || null, version: s.version || 1, createdAt: s.createdAt || old.createdAt || Date.now(), updatedAt: Date.now() });
  writeAll_('hourlyRates', sortHist_(s.hourlyRates || []));
  writeAll_('holidayCoefs', sortHist_(s.holidayCoefs || []));
  writeAll_('taxRates', sortHist_(s.taxRates || []));
  writeAll_('categories', s.categories || []);
  writeAll_('holidays', (s.holidays || []).slice().sort().map(function (d) { return { date: d }; }));
}
function sortHist_(l) { return l.slice().sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : (a.createdAt || 0) - (b.createdAt || 0); }); }
var PENDING_PERIODS_ = null; // метаданные периодов из текущего вызова; записываются при пересчёте
function writePeriodsMeta_(map) { PENDING_PERIODS_ = map || {}; }
function appendLog_(rows) {
  var sh = sheetOf_('log'), start = sh.getLastRow() + 1;
  var rg = sh.getRange(start, 1, rows.length, 2);
  rg.setNumberFormats(rows.map(function () { return ['dd.MM.yyyy HH:mm:ss', '@']; }));
  rg.setValues(rows.map(function (r) { return [new Date(r.at), r.text]; }));
}

/* ---------- Пересчёт листа «Расчёты зарплаты» ---------- */
function recalc_() {
  var st = loadState_();
  if (PENDING_PERIODS_) { st.periods = PENDING_PERIODS_; PENDING_PERIODS_ = null; }
  if (!st.settings) { writeAll_('periods', []); return; }
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var months = [today];
  st.shifts.forEach(function (s) { months.push(s.date.slice(0, 7)); });
  st.upsells.forEach(function (u) { months.push(u.payMonth || u.date.slice(0, 7)); });
  st.payments.forEach(function (p) { months.push(p.month); });
  Object.keys(st.periods).forEach(function (k) { months.push(k.slice(0, 7)); });
  months.sort();
  var rows = [], now = Date.now();
  for (var m = months[0], guard = 0; m <= months[months.length - 1] && guard < 240; m = Engine.addMonths(m, 1), guard++) {
    [1, 2].forEach(function (h) {
      var p = Engine.computePeriod(st, m, h), ps = Engine.paymentSummary(st, m, h), meta = st.periods[p.key] || {};
      var hasData = p.totalMin || p.upsells.length || ps.received || Object.keys(meta).length || m === today;
      if (!hasData) return;
      rows.push({ key: p.key, month: m, halfName: h === 1 ? 'Первая половина' : 'Вторая половина', from: p.from, to: p.to,
        regularH: p.regularMin / 60, holidayH: p.holidayMin / 60, regularPay: p.regularPay, holidayPay: p.holidayPay, base: p.base,
        upsConfirmed: p.upsConfirmed, upsPending: p.upsPending, accrued: p.accrued, taxRate: p.taxRate, tax: p.tax, net: p.net,
        received: ps.received, diff: ps.diff, payStatus: PAY_RU[ps.status], closed: !!meta.closed, closedAt: meta.closedAt || null,
        taxRateSnap: meta.taxRateSnap, taxRateOverride: meta.taxRateOverride, taxManual: meta.taxManual, updatedAt: now });
    });
  }
  writeAll_('periods', rows);
}
function recalcNow_() { var lock = LockService.getScriptLock(); lock.waitLock(30000); try { recalc_(); return bump_(); } finally { lock.releaseLock(); } }

/* ---------- Резервные копии ---------- */
function folder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
function stamp_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm'); }
function exportAll_() {
  var st = loadState_();
  st.log = readLog_(100000);
  return JSON.stringify({ format: 'salary-tracker-backup', version: 2, source: 'google-sheets', exportedAt: new Date().toISOString(),
    settings: st.settings, periods: st.periods, log: st.log, shifts: st.shifts, upsells: st.upsells, payments: st.payments });
}
function backupNow_(reason) {
  var f = folder_(BACKUP_FOLDER), name = APP_TITLE + ' — ' + (reason === 'auto' ? 'автокопия ' : 'копия ') + stamp_();
  var copy = DriveApp.getFileById(ss_().getId()).makeCopy(name, f);
  f.createFile(Utilities.newBlob(exportAll_(), 'application/json', name + '.json'));
  var kv = readSettingsKV_(); kv.lastBackupAt = Date.now(); if (Object.keys(kv).length > 1) writeSettingsKV_(kv);
  if (reason === 'auto') pruneAuto_(f);
  appendLog_([{ at: Date.now(), text: reason === 'auto' ? 'Автоматическая резервная копия' : reason === 'restore' ? 'Страховочная копия перед восстановлением' : 'Создана резервная копия в Google Диске' }]);
  bump_();
  return JSON.stringify({ name: name, url: copy.getUrl(), folderUrl: f.getUrl(), at: Date.now() });
}
// Запускается только триггером по расписанию (у вызова из браузера нет triggerUid)
function autoBackup(e) { if (!e || !e.triggerUid) return; backupNow_('auto'); }
function pruneAuto_(f) {
  var files = [], it = f.getFiles();
  while (it.hasNext()) { var x = it.next(); if (x.getName().indexOf('автокопия') >= 0) files.push(x); }
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(KEEP_AUTO_BACKUPS * 2).forEach(function (x) { x.setTrashed(true); }); // таблица + JSON на каждую копию
}
function setAutoBackup_(on) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'autoBackup') ScriptApp.deleteTrigger(t); });
  if (on) ScriptApp.newTrigger('autoBackup').timeBased().everyDays(1).atHour(3).create();
  var kv = readSettingsKV_(); kv.autoBackup = !!on; writeSettingsKV_(kv);
  appendLog_([{ at: Date.now(), text: on ? 'Включена ежедневная резервная копия' : 'Ежедневная резервная копия отключена' }]);
  return bump_();
}
function backupInfo_() {
  var f = folder_(BACKUP_FOLDER), kv = readSettingsKV_();
  return JSON.stringify({ folderUrl: f.getUrl(), lastBackupAt: kv.lastBackupAt || null, autoBackup: !!kv.autoBackup,
    trigger: ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'autoBackup'; }) });
}
function restoreAll_(json, mode) {
  var b = JSON.parse(json);
  if (!b || b.format !== 'salary-tracker-backup' || !b.settings) throw new Error('Это не резервная копия приложения «Мой заработок»');
  backupNow_('restore');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var cur = loadState_();
    writeSettings_(b.settings);
    ['shifts', 'upsells', 'payments'].forEach(function (k) {
      var incoming = (b[k] || []).filter(function (x) { return x && x.id; });
      var list = incoming;
      if (mode !== 'replace') { var ids = {}; incoming.forEach(function (x) { ids[x.id] = 1; }); list = cur[k].filter(function (x) { return !ids[x.id]; }).concat(incoming); }
      writeAll_(k, list);
    });
    var periods = mode === 'replace' ? (b.periods || {}) : Object.assign({}, cur.periods, b.periods || {});
    writePeriodsMeta_(periods);
    if (mode === 'replace' && b.log && b.log.length) { writeAll_('log', b.log.slice().sort(function (x, y) { return x.at - y.at; })); }
    appendLog_([{ at: Date.now(), text: 'Восстановлены данные из копии (' + (mode === 'replace' ? 'замена' : 'объединение') + ')' }]);
    recalc_();
    return bump_();
  } finally { lock.releaseLock(); }
}
function saveToDrive_(name, base64, mime) {
  var f = folder_(EXPORT_FOLDER);
  var file = f.createFile(Utilities.newBlob(Utilities.base64Decode(base64), mime, name));
  return JSON.stringify({ url: file.getUrl(), folderUrl: f.getUrl(), name: name });
}

/* ---------- Ручной запуск из редактора ---------- */
function setup() { ownerOnly_(); PropertiesService.getScriptProperties().deleteProperty('schema'); ensureSheets_(); recalcNow_(); return 'Листы созданы: ' + ss_().getSheets().map(function (s) { return s.getName(); }).join(', '); }
