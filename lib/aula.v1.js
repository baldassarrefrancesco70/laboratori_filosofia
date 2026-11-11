/* aula.v1.js — libreria condivisa per le lezioni interattive (e i laboratori che vogliano usarla).
 *
 * Componenti: sondaggio, abbinamento, risposta breve, schema in fieri, timer, QR d'ingresso.
 * Due viste dello stesso file HTML:
 *   - proiezione (predefinita): palco 16:9, navigazione da tastiera e telecomando;
 *   - dispositivo (?v=dispositivo&s=CODICE): telefono dello studente, segue la proiezione.
 *
 * Dati: Firebase Realtime Database via REST (nessuna API key, nessun SDK).
 *   <percorso>/sessioni/<S>/stato                 {passo, attivita, aperta, t}
 *   <percorso>/sessioni/<S>/presenze/<codice>     timestamp
 *   <percorso>/sessioni/<S>/risposte/<att>/<codice> risposta
 * Il codice studente è casuale (5 caratteri): niente nomi, niente email, nessun punteggio.
 * La libreria scrive e legge SOLO sotto <percorso>; non cancella mai nulla.
 * Nascondere una risposta sul muro è solo locale (localStorage del computer del docente).
 *
 * Sessione = codice della classe scelto dal docente sulla prima schermata (3-8 lettere o cifre, es. 4D26),
 * lo stesso per tutte le lezioni: ogni lezione ha il suo <percorso>, quindi i dati non si mescolano.
 * Ripresa da qualsiasi computer: riscrivendo il codice, la proiezione rilegge stato/passo dal database e
 * riparte da lì; le attività che hanno già risposte si riaprono come ripresa, non come attività.
 *
 * Parametri URL utili: v=dispositivo · s=<sessione> · db=<url database> (solo per prove)
 *   v=docente: vista del docente da NON proiettare (telefono o portatile): chi ha risposto che cosa,
 *   per le attività che la prevedono (quiz). Legge soltanto, non scrive nulla.
 * Opzioni di Aula.avvia: squadre:true → i dispositivi sono squadre (testi «squadra/squadre»).
 * Attività «svelabili» (quiz): → chiude gli invii, → svela la soluzione, → passo successivo.
 *   Lo svelamento è solo sulla proiezione e non va nel database. S salta al passo successivo.
 * Passo con riepilogo:true: sui dispositivi compaiono tutte le domande del quiz con soluzione e
 *   spiegazione, accanto alla risposta data da quel dispositivo; nessun conteggio, nessun punteggio.
 *   v=descrizione: usato dal portale (lezioni/index.html) per leggere l'elenco delle attività.
 *
 * Uso:
 *   <link rel="stylesheet" href="../lib/aula.v1.css">
 *   <script src="../lib/vendor/qrcode.js"></script>
 *   <script src="../lib/aula.v1.js"></script>
 *   <script>Aula.avvia({ titolo, percorso, database, passi:[...] })</script>
 * Ogni passo: { titolo, html, note, minuti, dispositivo, attivita, risultatiDi, tipo:'copertina' }
 * Nei passi, gli elementi con data-f="n" compaiono al frammento n (avanti/indietro).
 */
(function () {
  'use strict';

  var VERSIONE = '1.0';
  var ALF = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var COLORI = ['var(--c1)', 'var(--c0)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)'];

  // ---------------------------------------------------------------- utilità
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function casuale(n) {
    var s = '', a = new Uint32Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < n; i++) s += ALF[a[i] % ALF.length];
    return s;
  }
  function leggiLS(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function scriviLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage non disponibile */ } }
  function param(n) { return new URLSearchParams(location.search).get(n); }
  function mmss(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function valori(o) { return o && typeof o === 'object' ? Object.keys(o).map(function (k) { return o[k]; }) : []; }

  // ---------------------------------------------------------------- database (REST + streaming SSE)
  function DB(base, radice) {
    this.base = (base || '').replace(/\/+$/, '');
    this.radice = radice;
    this.attivo = !!this.base;
    this.onConn = function () {};
  }
  DB.prototype.url = function (p) { return this.base + '/' + this.radice + '/' + p + '.json'; };
  DB.prototype.leggi = function (p) {
    var self = this;
    if (!this.attivo) return Promise.reject(new Error('nessun database'));
    return fetch(this.url(p), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      self.onConn(true);
      return r.json();
    }).catch(function (e) { self.onConn(false); throw e; });
  };
  DB.prototype.put = function (p, v) {
    var self = this;
    if (!this.attivo) return Promise.reject(new Error('nessun database'));
    return fetch(this.url(p), { method: 'PUT', body: JSON.stringify(v) }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      self.onConn(true);
      return r.json();
    }).catch(function (e) { self.onConn(false); throw e; });
  };
  function mettiInPercorso(radice, path, val) {
    var parti = String(path || '/').split('/').filter(Boolean);
    if (!parti.length) return val;
    if (!radice || typeof radice !== 'object') radice = {};
    var o = radice;
    for (var i = 0; i < parti.length - 1; i++) {
      if (!o[parti[i]] || typeof o[parti[i]] !== 'object') o[parti[i]] = {};
      o = o[parti[i]];
    }
    if (val === null) delete o[parti[parti.length - 1]]; else o[parti[parti.length - 1]] = val;
    return radice;
  }
  // Ascolta un nodo: streaming con EventSource; se non funziona, interrogazione ogni 2 s.
  DB.prototype.ascolta = function (p, cb) {
    var self = this, url = this.url(p), dati = null, es = null, giro = null, fermo = false, ricevuto = false;
    if (!this.attivo) { cb(null); return function () {}; }
    function interroga() {
      if (giro || fermo) return;
      var una = function () {
        fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(function (d) { self.onConn(true); dati = d; if (!fermo) cb(dati); })
          .catch(function () { self.onConn(false); });
      };
      una(); giro = setInterval(una, 2000);
    }
    try {
      es = new EventSource(url);
      es.addEventListener('put', function (e) {
        var m = JSON.parse(e.data); ricevuto = true; self.onConn(true);
        dati = mettiInPercorso(dati, m.path, m.data); if (!fermo) cb(dati);
      });
      es.addEventListener('patch', function (e) {
        var m = JSON.parse(e.data); ricevuto = true;
        Object.keys(m.data || {}).forEach(function (k) {
          dati = mettiInPercorso(dati, (m.path === '/' ? '' : m.path) + '/' + k, m.data[k]);
        });
        if (!fermo) cb(dati);
      });
      es.addEventListener('cancel', function () { es.close(); interroga(); });
      es.onerror = function () {
        self.onConn(false);
        if (!ricevuto) { es.close(); interroga(); } // lo streaming non è mai partito: ripiego
      };
    } catch (err) { interroga(); }
    return function () { fermo = true; if (es) es.close(); if (giro) clearInterval(giro); };
  };

  // ---------------------------------------------------------------- componenti
  var C = {};

  // SONDAGGIO -------------------------------------------------------
  // att: {tipo:'sondaggio', domanda, opzioni:[...], confronta:'idAltroSondaggio', etichette:['Prima','Dopo']}
  C.sondaggio = {
    conta: function (att, dati) {
      var n = att.opzioni.map(function () { return 0; }), tot = 0;
      valori(dati).forEach(function (v) { if (typeof v === 'number' && n[v] != null) { n[v]++; tot++; } });
      return { n: n, tot: tot };
    },
    proiezione: function (box, att, dati, ctx) {
      var a = C.sondaggio.conta(att, dati);
      var b = att.confronta ? C.sondaggio.conta(att, ctx.datiConfronto) : null;
      box.innerHTML = '';
      var wrap = el('div', 'barre' + (b ? ' confronto' : ''));
      att.opzioni.forEach(function (o, i) {
        if (b) {
          [[b, 'prima', att.etichette ? att.etichette[0] : 'Prima'], [a, '', att.etichette ? att.etichette[1] : 'Ora']].forEach(function (x, j) {
            var p = x[0].tot ? Math.round(100 * x[0].n[i] / x[0].tot) : 0;
            var r = el('div', 'barra');
            r.innerHTML = '<div>' + (j === 0 ? esc(o) : '') + '</div><div class="bar ' + x[1] + '"><i style="width:' + p + '%"></i></div>' +
              '<div class="num">' + x[0].n[i] + ' <small>' + p + '%</small></div>';
            if (j === 0) r.style.marginTop = i ? '10px' : '0';
            wrap.appendChild(r);
          });
        } else {
          var p = a.tot ? Math.round(100 * a.n[i] / a.tot) : 0;
          var r = el('div', 'barra');
          r.innerHTML = '<div>' + esc(o) + '</div><div class="bar"><i style="width:' + p + '%"></i></div><div class="num">' + a.n[i] + ' <small>' + p + '%</small></div>';
          wrap.appendChild(r);
        }
      });
      box.appendChild(wrap);
      var leg = el('div', 'legenda');
      if (b) {
        leg.innerHTML = '<span style="--q:#9FB7CE">' + esc(att.etichette ? att.etichette[0] : 'Prima') + ': ' + b.tot + ' risposte</span>' +
          '<span style="--q:var(--blu)">' + esc(att.etichette ? att.etichette[1] : 'Ora') + ': ' + a.tot + ' risposte</span>';
      } else leg.textContent = a.tot + (a.tot === 1 ? ' risposta' : ' risposte');
      box.appendChild(leg);
    },
    dispositivo: function (box, att, mia, invia) {
      var card = el('div', 'disp-card');
      card.appendChild(el('h2', '', esc(att.domanda)));
      card.appendChild(el('p', 'istr', 'Tocca una risposta. Puoi cambiarla finché il sondaggio è aperto.'));
      var esito = el('div', 'disp-esito');
      att.opzioni.forEach(function (o, i) {
        var b = el('button', 'disp-btn' + (mia === i ? ' scelto' : ''), esc(o));
        b.type = 'button';
        b.onclick = function () {
          card.querySelectorAll('.disp-btn').forEach(function (x) { x.classList.remove('scelto'); });
          b.classList.add('scelto');
          invia(i, esito);
        };
        card.appendChild(b);
      });
      card.appendChild(esito);
      box.appendChild(card);
    }
  };

  // ABBINAMENTO -----------------------------------------------------
  // att: {tipo:'abbinamento', consegna, categorie:[...], voci:[{testo, fonte, atteso:indiceCategoria}]}
  // risposta: {indiceVoce: indiceCategoria}
  C.abbinamento = {
    proiezione: function (box, att, dati, ctx) {
      box.innerHTML = '';
      var tot = valori(dati).length;
      var leg = el('div', 'abb-legenda');
      att.categorie.forEach(function (c, j) { var s = el('span', '', esc(c)); s.style.setProperty('--q', COLORI[j % COLORI.length]); leg.appendChild(s); });
      box.appendChild(leg);
      var lista = el('div', 'abb');
      att.voci.forEach(function (v, i) {
        var n = att.categorie.map(function () { return 0; }), t = 0;
        valori(dati).forEach(function (r) { if (r && r[i] != null && n[r[i]] != null) { n[r[i]]++; t++; } });
        var riga = el('div', 'abb-riga');
        var voce = el('div', 'voce', esc(v.testo) + (v.fonte ? ' <small>(' + esc(v.fonte) + ')</small>' : ''));
        var destra = el('div');
        var pila = el('div', 'abb-pila');
        att.categorie.forEach(function (c, j) {
          var b = el('b', '', n[j] ? String(n[j]) : '');
          b.style.background = COLORI[j % COLORI.length];
          b.style.flexGrow = n[j];
          b.style.flexBasis = '0';
          pila.appendChild(b);
        });
        destra.appendChild(pila);
        if (ctx.modo === 'ripresa' && v.atteso != null) {
          var at = el('div', 'abb-atteso', '→ ' + esc(att.categorie[v.atteso]));
          at.style.color = COLORI[v.atteso % COLORI.length];
          destra.appendChild(at);
        }
        riga.appendChild(voce); riga.appendChild(destra);
        lista.appendChild(riga);
      });
      box.appendChild(lista);
      box.appendChild(el('div', 'legenda', tot + (tot === 1 ? ' dispositivo ha risposto' : ' dispositivi hanno risposto')));
    },
    dispositivo: function (box, att, mia, invia) {
      mia = mia && typeof mia === 'object' ? mia : {};
      var card = el('div', 'disp-card');
      card.appendChild(el('h2', '', esc(att.consegna || 'Abbina')));
      card.appendChild(el('p', 'istr', 'Per ogni voce tocca la scelta. Le risposte partono subito; puoi correggerle finché l\'attività è aperta.'));
      var esito = el('div', 'disp-esito');
      att.voci.forEach(function (v, i) {
        var d = el('div', 'disp-voce');
        d.appendChild(el('p', '', esc(v.testo)));
        var opz = el('div', 'disp-opz');
        att.categorie.forEach(function (c, j) {
          var b = el('button', mia[i] === j ? 'scelto' : '', esc(c));
          b.type = 'button';
          b.onclick = function () {
            opz.querySelectorAll('button').forEach(function (x) { x.classList.remove('scelto'); });
            b.classList.add('scelto');
            mia[i] = j;
            invia(Object.assign({}, mia), esito);
          };
          opz.appendChild(b);
        });
        d.appendChild(opz);
        card.appendChild(d);
      });
      card.appendChild(esito);
      box.appendChild(card);
    }
  };

  // RISPOSTA BREVE --------------------------------------------------
  // att: {tipo:'breve', domanda, max:200, segnaposto}
  C.breve = {
    proiezione: function (box, att, dati, ctx) {
      box.innerHTML = '';
      var chiave = 'aula:nascoste:' + ctx.sessione + ':' + att.id;
      var stato = leggiLS(chiave, {});
      var voci = Object.keys(dati || {}).map(function (k) { return { k: k, v: dati[k] }; })
        .filter(function (x) { return x.v && typeof x.v.testo === 'string' && x.v.testo.trim(); })
        .sort(function (a, b) { return (a.v.t || 0) - (b.v.t || 0); });
      if (!voci.length) { box.appendChild(el('div', 'vuoto', 'Ancora nessuna risposta.')); return; }
      var muro = el('div', 'muro');
      voci.forEach(function (x) {
        var c = el('div', 'bigl' + (stato[x.k] === 'n' ? ' nasc' : stato[x.k] === 'e' ? ' evid' : ''));
        c.textContent = x.v.testo;
        c.title = 'Clic: evidenzia · Maiusc+clic: nascondi (solo su questo computer)';
        c.onclick = function (e) {
          var s = leggiLS(chiave, {});
          if (e.shiftKey || e.altKey) s[x.k] = s[x.k] === 'n' ? '' : 'n';
          else s[x.k] = s[x.k] === 'e' ? '' : 'e';
          scriviLS(chiave, s);
          C.breve.proiezione(box, att, dati, ctx);
        };
        muro.appendChild(c);
      });
      box.appendChild(muro);
      adatta(muro, box, 28, 15);
      box.appendChild(el('div', 'legenda', voci.length + (voci.length === 1 ? ' risposta' : ' risposte')));
    },
    dispositivo: function (box, att, mia, invia) {
      var max = att.max || 200;
      var card = el('div', 'disp-card');
      card.appendChild(el('h2', '', esc(att.domanda)));
      card.appendChild(el('p', 'istr', 'Una risposta breve, al massimo ' + max + ' caratteri. Compare sulla proiezione senza nome. Puoi correggerla e inviarla di nuovo.'));
      var ta = el('textarea'); ta.maxLength = max; ta.placeholder = att.segnaposto || 'Scrivi qui';
      ta.value = mia && mia.testo ? mia.testo : '';
      var conta = el('div', 'disp-conta');
      var aggiorna = function () { conta.textContent = ta.value.length + ' / ' + max; };
      ta.oninput = aggiorna; aggiorna();
      var b = el('button', 'disp-invia', mia && mia.testo ? 'Invia di nuovo' : 'Invia'); b.type = 'button';
      var esito = el('div', 'disp-esito');
      b.onclick = function () {
        var t = ta.value.trim();
        if (!t) { esito.className = 'disp-esito ko'; esito.textContent = 'Scrivi qualcosa prima di inviare.'; return; }
        invia({ testo: t.slice(0, max), t: Date.now() }, esito, function () { b.textContent = 'Invia di nuovo'; });
      };
      card.appendChild(ta); card.appendChild(conta); card.appendChild(b); card.appendChild(esito);
      box.appendChild(card);
    }
  };

  // SCHEMA IN FIERI -------------------------------------------------
  // att: {tipo:'schema', consegna, caselle:[{titolo, sotto}], colonne:2,
  //       termini:[{testo, atteso:indiceCasella}]   → ogni studente colloca i termini (risposta {iTermine: iCasella})
  //   oppure libero:true, max:80                  → ogni studente scrive una parola o frase per casella (risposta {iCasella: testo})}
  C.schema = {
    proiezione: function (box, att, dati, ctx) {
      box.innerHTML = '';
      var sch = el('div', 'schema');
      sch.style.gridTemplateColumns = 'repeat(' + (att.colonne || att.caselle.length) + ',1fr)';
      var risp = valori(dati);
      att.caselle.forEach(function (cas, ci) {
        var c = el('div', 'casella');
        c.appendChild(el('h3', '', esc(cas.titolo)));
        if (cas.sotto) c.appendChild(el('div', 'sotto', esc(cas.sotto)));
        var g = el('div', 'gettoni');
        var conti = {};
        if (att.libero) {
          risp.forEach(function (r) {
            var t = r && r[ci]; if (typeof t !== 'string' || !t.trim()) return;
            var k = t.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.;:,!]+$/, '');
            if (!conti[k]) conti[k] = { testo: t.trim(), n: 0 };
            conti[k].n++;
          });
        } else {
          att.termini.forEach(function (tm, ti) {
            var n = 0; risp.forEach(function (r) { if (r && r[ti] === ci) n++; });
            if (n) conti[ti] = { testo: tm.testo, n: n, atteso: tm.atteso === ci };
          });
        }
        Object.keys(conti).map(function (k) { return conti[k]; }).sort(function (a, b) { return b.n - a.n; }).forEach(function (x) {
          var cls = 'gettone';
          if (ctx.modo === 'ripresa' && !att.libero) cls += x.atteso ? ' atteso' : ' fuori';
          var gt = el('span', cls, esc(x.testo) + (x.n > 1 || !att.libero ? ' <i>' + x.n + '</i>' : ''));
          gt.style.fontSize = Math.min(34, 20 + 2 * x.n) + 'px';
          g.appendChild(gt);
        });
        if (!g.children.length) g.appendChild(el('div', 'vuoto', '…'));
        c.appendChild(g);
        sch.appendChild(c);
      });
      box.appendChild(sch);
      box.appendChild(el('div', 'legenda', risp.length + (risp.length === 1 ? ' dispositivo ha risposto' : ' dispositivi hanno risposto') +
        (ctx.modo === 'ripresa' && !att.libero ? ' · in verde la collocazione del testo' : '')));
    },
    dispositivo: function (box, att, mia, invia) {
      mia = mia && typeof mia === 'object' ? mia : {};
      var card = el('div', 'disp-card');
      card.appendChild(el('h2', '', esc(att.consegna || 'Completa lo schema')));
      var esito = el('div', 'disp-esito');
      if (att.libero) {
        var max = att.max || 80;
        card.appendChild(el('p', 'istr', 'Scrivi poche parole per ogni casella (al massimo ' + max + ' caratteri). Compaiono nello schema sulla proiezione, senza nome.'));
        var campi = att.caselle.map(function (cas, ci) {
          var d = el('div', 'disp-voce');
          d.appendChild(el('p', '', '<b>' + esc(cas.titolo) + '</b>' + (cas.sotto ? '<br><small>' + esc(cas.sotto) + '</small>' : '')));
          var i = el('input'); i.type = 'text'; i.maxLength = max; i.value = typeof mia[ci] === 'string' ? mia[ci] : '';
          d.appendChild(i); card.appendChild(d); return i;
        });
        var b = el('button', 'disp-invia', 'Invia'); b.type = 'button';
        b.onclick = function () {
          var r = {}, vuota = true;
          campi.forEach(function (i, ci) { var t = i.value.trim(); if (t) { r[ci] = t.slice(0, max); vuota = false; } });
          if (vuota) { esito.className = 'disp-esito ko'; esito.textContent = 'Scrivi almeno in una casella.'; return; }
          invia(r, esito, function () { b.textContent = 'Invia di nuovo'; });
        };
        card.appendChild(b);
      } else {
        card.appendChild(el('p', 'istr', 'Per ogni termine scegli in quale parte dello schema va. Le scelte partono subito; puoi correggerle finché l\'attività è aperta.'));
        att.termini.forEach(function (tm, ti) {
          var d = el('div', 'disp-voce');
          d.appendChild(el('p', '', '<b>' + esc(tm.testo) + '</b>'));
          var opz = el('div', 'disp-opz');
          att.caselle.forEach(function (cas, ci) {
            var b = el('button', mia[ti] === ci ? 'scelto' : '', esc(cas.breve || cas.titolo)); b.type = 'button';
            b.onclick = function () {
              opz.querySelectorAll('button').forEach(function (x) { x.classList.remove('scelto'); });
              b.classList.add('scelto'); mia[ti] = ci; invia(Object.assign({}, mia), esito);
            };
            opz.appendChild(b);
          });
          d.appendChild(opz); card.appendChild(d);
        });
      }
      card.appendChild(esito);
      box.appendChild(card);
    }
  };

  // QUIZ (a squadre) ------------------------------------------------
  // att: {tipo:'quiz', domanda, opzioni:[...], giusta:indice, spiegazione, rimando, saltabile, minuti}
  // risposta: {r: indice dell'opzione, s: 0 poco · 1 abbastanza · 2 molto sicuri, u: 1 unanimi · 0 no}
  // Proiezione in tre stati: aperta (solo quanti hanno inviato), chiusa (distribuzione senza soluzione),
  // svelata (soluzione, spiegazione, rimando). Mai chi ha risposto che cosa: quello sta nella vista docente.
  var LETTERE = 'abcdefgh';
  var SICUREZZA = ['poco', 'abbastanza', 'molto'];
  function rispostaQuiz(v, n) {
    return v && typeof v === 'object' && typeof v.r === 'number' && v.r >= 0 && v.r < n ? v : null;
  }
  C.quiz = {
    svelabile: true,
    conta: function (att, dati) {
      var righe = att.opzioni.map(function () { return { n: 0, u: 0, s: [0, 0, 0] }; }), tot = 0;
      valori(dati).forEach(function (v) {
        v = rispostaQuiz(v, att.opzioni.length); if (!v) return;
        var x = righe[v.r]; x.n++; tot++;
        if (v.u === 1) x.u++;
        if (v.s >= 0 && v.s <= 2) x.s[v.s]++;
      });
      return { righe: righe, tot: tot };
    },
    proiezione: function (box, att, dati, ctx) {
      box.innerHTML = '';
      var c = C.quiz.conta(att, dati);
      var max = Math.max.apply(null, c.righe.map(function (x) { return x.n; }).concat([1]));
      var aperta = ctx.modo === 'lavoro', svelata = !aperta && ctx.svelata;
      var q = el('div', 'quiz' + (aperta ? ' aperta' : '') + (svelata ? ' svelata' : ''));
      q.appendChild(el('div', 'quiz-domanda', esc(att.domanda)));
      var lista = el('div', 'quiz-opz');
      att.opzioni.forEach(function (o, i) {
        var x = c.righe[i];
        var r = el('div', 'quiz-riga' + (svelata ? (i === att.giusta ? ' giusta' : ' altra') : ''));
        var h = '<div class="quiz-testo"><b class="lettera">' + LETTERE[i] + '</b><span>' + esc(o) + '</span></div>';
        if (!aperta) {
          h += '<div class="quiz-dati"><div class="quiz-bar">';
          [2, 1, 0].forEach(function (s) {
            if (x.s[s]) h += '<i class="s' + s + '" style="width:' + (100 * x.s[s] / max) + '%">' + x.s[s] + '</i>';
          });
          h += '</div><div class="quiz-num"><b>' + x.n + '</b> ' + (x.n === 1 ? 'squadra' : 'squadre') +
            (x.n ? ' · ' + x.u + (x.u === 1 ? ' unanime' : ' unanimi') : '') + '</div></div>';
        }
        r.innerHTML = h;
        lista.appendChild(r);
      });
      q.appendChild(lista);
      if (aperta) {
        q.appendChild(el('div', 'quiz-legenda', '<span><b>' + c.tot + '</b> ' + (c.tot === 1 ? 'squadra ha inviato' : 'squadre hanno inviato') + '</span>'));
      } else {
        q.appendChild(el('div', 'quiz-legenda',
          '<span class="q s2">molto sicure</span><span class="q s1">abbastanza</span><span class="q s0">poco</span>' +
          '<span>' + c.tot + (c.tot === 1 ? ' risposta' : ' risposte') + '</span>'));
      }
      if (svelata) {
        q.appendChild(el('div', 'quiz-spieg', '<b>Giusta: ' + LETTERE[att.giusta] + '.</b> ' + esc(att.spiegazione || '') +
          (att.rimando ? ' <span class="rimando">' + esc(att.rimando) + '</span>' : '')));
      }
      box.appendChild(q);
      // il corpo si riduce finché tutto sta nel riquadro (domande e spiegazioni lunghe)
      var fs = 30;
      q.style.setProperty('--fs', fs + 'px');
      while (fs > 16 && q.scrollHeight > box.clientHeight) { fs -= 1; q.style.setProperty('--fs', fs + 'px'); }
    },
    dispositivo: function (box, att, mia, invia) {
      var v = rispostaQuiz(mia, att.opzioni.length) || {};
      var sc = { r: v.r, s: v.s, u: v.u }, inviata = !!rispostaQuiz(mia, att.opzioni.length);
      var card = el('div', 'disp-card disp-quiz');
      card.appendChild(el('h2', '', esc(att.domanda)));
      var esito = el('div', 'disp-esito');
      var btn = el('button', 'disp-invia', inviata ? 'Invia di nuovo' : 'Invia'); btn.type = 'button';
      function pronto() {
        btn.disabled = !(sc.r != null && sc.s != null && sc.u != null);
        if (inviata) { esito.className = 'disp-esito'; esito.textContent = 'Avete cambiato qualcosa: premete di nuovo Invia.'; }
      }
      function gruppo(titolo, voci, campo, cls) {
        var d = el('div', 'disp-voce');
        d.appendChild(el('p', '', '<b>' + titolo + '</b>'));
        var g = el('div', cls);
        voci.forEach(function (t, i) {
          var b = el('button', (cls === 'disp-opz' ? '' : 'disp-btn') + (sc[campo] === i ? ' scelto' : ''), t); b.type = 'button';
          b.onclick = function () {
            g.querySelectorAll('button').forEach(function (x) { x.classList.remove('scelto'); });
            b.classList.add('scelto'); sc[campo] = i; pronto();
          };
          g.appendChild(b);
        });
        d.appendChild(g); card.appendChild(d);
      }
      gruppo('1 · La vostra risposta', att.opzioni.map(function (o, i) { return '<b class="lettera">' + LETTERE[i] + '</b> ' + esc(o); }), 'r', 'disp-lista');
      gruppo('2 · Quanto siete sicuri?', ['Poco', 'Abbastanza', 'Molto'], 's', 'disp-opz');
      gruppo('3 · Avete scelto all\'unanimità?', ['No', 'Sì'], 'u', 'disp-opz');
      btn.onclick = function () {
        if (btn.disabled) return;
        invia({ r: sc.r, s: sc.s, u: sc.u }, esito, function () { inviata = true; btn.textContent = 'Invia di nuovo'; });
      };
      card.appendChild(btn); card.appendChild(esito);
      box.appendChild(card);
      btn.disabled = !(sc.r != null && sc.s != null && sc.u != null);
      if (inviata) { esito.className = 'disp-esito ok'; esito.textContent = 'Inviata ✓ Potete correggerla finché la domanda è aperta.'; }
    },
    // vista docente (non proiettata): chi ha risposto che cosa, con le squadre da cui partire
    docente: function (box, att, dati) {
      var righe = Object.keys(dati || {}).map(function (k) { return { k: k, v: rispostaQuiz(dati[k], att.opzioni.length) }; })
        .filter(function (x) { return x.v; });
      righe.forEach(function (x) {
        x.errata = x.v.r !== att.giusta;
        x.allarme = x.errata && x.v.s === 2 && x.v.u === 1;
        x.divisa = x.v.u === 0;
        x.ord = x.allarme ? 0 : x.divisa ? 1 : x.errata ? 2 : 3;
      });
      righe.sort(function (a, b) { return a.ord - b.ord || a.k.localeCompare(b.k); });
      var h = '<p class="doc-dom">' + esc(att.domanda) + '</p><p class="doc-giusta">Giusta: <b>' + LETTERE[att.giusta] + '</b> · ' +
        righe.length + (righe.length === 1 ? ' squadra ha risposto' : ' squadre hanno risposto') + '</p>';
      if (!righe.length) h += '<p class="disp-attesa">Ancora nessuna risposta.</p>';
      else {
        h += '<table class="doc-tab"><thead><tr><th>Squadra</th><th>Risp.</th><th>Sicurezza</th><th>Unanimi</th></tr></thead><tbody>';
        righe.forEach(function (x) {
          h += '<tr class="' + (x.allarme ? 'allarme' : x.divisa ? 'divisa' : '') + '"><td class="cod">' + esc(x.k) + '</td>' +
            '<td>' + LETTERE[x.v.r] + (x.errata ? ' ✗' : ' ✓') + '</td><td>' + (SICUREZZA[x.v.s] || '–') + '</td><td>' + (x.v.u === 1 ? 'sì' : 'no') + '</td></tr>';
        });
        h += '</tbody></table><p class="doc-leg"><span class="allarme">molto sicure, unanimi e in errore</span> <span class="divisa">non unanimi</span></p>';
      }
      box.innerHTML = h;
    }
  };

  // riduce il corpo del testo finché il contenuto sta nel riquadro
  function adatta(contenuto, riquadro, max, min) {
    var fs = max;
    contenuto.style.setProperty('--fs', fs + 'px');
    var limite = riquadro.clientHeight - 40;
    while (fs > min && contenuto.scrollHeight > limite) {
      fs -= 1; contenuto.style.setProperty('--fs', fs + 'px');
      if (fs < 20) contenuto.style.columns = '4';
    }
  }

  // ---------------------------------------------------------------- QR
  function qrSvg(testo) {
    if (typeof window.qrcode !== 'function') return '<p>QR non disponibile</p>';
    var q = window.qrcode(0, 'M'); q.addData(testo); q.make();
    return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }

  // ---------------------------------------------------------------- disegno di mappe (slide ricomposte come testo)
  // Coordinate in px dentro l'area del corpo (1600×726). Restituiscono stringhe HTML.
  var FORME = {
    giu: '25,0 75,0 75,50 100,50 50,100 0,50 25,50',
    su: '25,100 75,100 75,50 100,50 50,0 0,50 25,50',
    sx: '100,25 100,75 50,75 50,100 0,50 50,0 50,25',
    dx: '0,25 0,75 50,75 50,100 100,50 50,0 50,25'
  };
  function stile(x, y, w, h) { return 'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px'; }
  var disegno = {
    box: function (x, y, w, h, cls, html, extra) {
      return '<div class="box ' + (cls || '') + '" style="' + stile(x, y, w, h) + '"' + (extra || '') + '>' + html + '</div>';
    },
    testo: function (x, y, w, h, cls, html, extra) {
      return '<div class="box ' + (cls || '') + '" style="' + stile(x, y, w, h) + ';padding:0"' + (extra || '') + '>' + html + '</div>';
    },
    freccia: function (dir, x, y, w, h, extra) {
      return '<div class="freccia" style="' + stile(x, y, w, h) + '"' + (extra || '') + '><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
        '<polygon points="' + FORME[dir] + '" fill="var(--freccia)" stroke="var(--rosso)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></div>';
    }
  };

  // ---------------------------------------------------------------- avvio
  var Aula = { VERSIONE: VERSIONE, componenti: C, disegno: disegno };

  // ?v=descrizione: la lezione non si avvia; manda al portale (stessa origine, in un iframe nascosto)
  // l'elenco delle attività, per tradurre le risposte in chiaro nel CSV.
  function descrivi(cfg) {
    var att = [];
    cfg.passi.forEach(function (p, i) {
      var a = p.attivita; if (!a) return;
      att.push({ passo: i + 1, id: a.id, tipo: a.tipo, domanda: a.domanda || a.consegna || p.titolo || '',
        opzioni: a.opzioni, categorie: a.categorie, voci: a.voci && a.voci.map(function (v) { return { testo: v.testo }; }),
        caselle: a.caselle && a.caselle.map(function (c) { return { titolo: c.titolo }; }),
        termini: a.termini && a.termini.map(function (t) { return { testo: t.testo }; }), libero: !!a.libero });
    });
    try { window.parent.postMessage({ tipo: 'aula-descrizione', percorso: cfg.percorso, titolo: cfg.titolo, attivita: att }, location.origin); } catch (e) { /* niente */ }
  }

  Aula.avvia = function (cfg) {
    var dbUrl = param('db') || cfg.database;
    var db = new DB(dbUrl, cfg.percorso);
    var attivita = {};
    cfg.passi.forEach(function (p) { if (p.attivita) attivita[p.attivita.id] = p.attivita; });
    var ctxBase = { cfg: cfg, db: db, attivita: attivita, dbParam: param('db') };
    document.title = cfg.titolo;
    if (param('v') === 'descrizione') { descrivi(cfg); return; }
    if (param('v') === 'dispositivo') avviaDispositivo(ctxBase);
    else if (param('v') === 'docente') avviaDocente(ctxBase);
    else avviaProiezione(ctxBase);
  };

  // ================================================================ PROIEZIONE
  // Prima schermata: il docente scrive il codice della classe; poi, se la sessione esiste già
  // nel database, si propone di riprendere dal passo in cui ci si era fermati.
  var CHIAVE_CLASSE = 'aula:codiceClasse';
  function nomi(cfg) { return cfg.squadre ? ['squadra', 'squadre'] : ['dispositivo', 'dispositivi']; }
  var RE_CODICE = /^[A-Z0-9]{3,8}$/;
  function pulisciCodice(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function avviaProiezione(X) {
    var S = pulisciCodice(param('s'));
    if (RE_CODICE.test(S)) preparaSessione(X, S);
    else schermataCodice(X);
  }

  function palcoSemplice() {
    document.body.className = 'aula-proiezione';
    document.body.innerHTML = '';
    var cornice = el('div', 'aula-cornice'), palco = el('div', 'aula-palco');
    cornice.appendChild(palco); document.body.appendChild(cornice);
    var scala = function () {
      var s = Math.min(window.innerWidth / 1600, window.innerHeight / 900);
      palco.style.transform = 'translate(' + ((window.innerWidth - 1600 * s) / 2) + 'px,' + ((window.innerHeight - 900 * s) / 2) + 'px) scale(' + s + ')';
    };
    window.addEventListener('resize', scala); scala();
    return palco;
  }

  function schermataCodice(X, avviso) {
    var cfg = X.cfg;
    var palco = palcoSemplice();
    var ultimo = leggiLS(CHIAVE_CLASSE, '') || '';
    palco.innerHTML =
      '<div class="aula-testata"><h1>' + esc(cfg.titolo) + '</h1></div>' +
      '<div class="aula-corpo"><form class="scelta-classe" autocomplete="off">' +
      '<h2>' + esc(cfg.titolo) + '</h2><p class="sott">' + esc(cfg.sottotitolo || '') + '</p>' +
      '<label for="aula-codice">Codice della classe</label>' +
      '<div class="riga"><input id="aula-codice" maxlength="8" spellcheck="false" value="' + esc(ultimo) + '" placeholder="es. 4D26">' +
      '<button type="submit">Inizia</button></div>' +
      '<p class="aiuto">Da 3 a 8 lettere o cifre, sempre lo stesso per la stessa classe (es. <b>4D26</b>). ' +
      'Con lo stesso codice si riprende la lezione da qualsiasi computer.</p>' +
      '<p class="avviso-codice">' + esc(avviso || '') + '</p>' +
      '</form></div>';
    var form = palco.querySelector('form'), inp = palco.querySelector('input');
    inp.focus(); inp.select();
    form.onsubmit = function (e) {
      e.preventDefault();
      var S = pulisciCodice(inp.value);
      if (!RE_CODICE.test(S)) { palco.querySelector('.avviso-codice').textContent = 'Il codice deve avere da 3 a 8 lettere o cifre, senza spazi.'; return; }
      preparaSessione(X, S);
    };
  }

  function preparaSessione(X, S) {
    var cfg = X.cfg, db = X.db, passi = cfg.passi;
    scriviLS(CHIAVE_CLASSE, S);
    try { var u = new URL(location.href); u.searchParams.set('s', S); history.replaceState(null, '', u.toString()); } catch (e) { /* niente */ }
    var chiaveP = 'aula:' + cfg.percorso + ':' + S + ':pos';
    var locale = leggiLS(chiaveP, null);
    // stesso browser: si riparte da dove si era, senza chiedere
    if (locale && locale.passo < passi.length) { avviaSessione(X, S, locale); return; }
    if (!db.attivo) { avviaSessione(X, S, null); return; }
    var palco = palcoSemplice();
    palco.innerHTML = '<div class="aula-testata"><h1>' + esc(cfg.titolo) + '</h1></div>' +
      '<div class="aula-corpo"><div class="scelta-classe"><p class="sott">Sessione <b>' + esc(S) + '</b>: controllo nel database…</p></div></div>';
    db.leggi('sessioni/' + S).then(function (d) {
      var fatte = Object.keys((d && d.risposte) || {});
      var st = d && d.stato;
      if (!st || !(st.passo > 0) || st.passo >= passi.length) { avviaSessione(X, S, { passo: 0, f: 0, modo: 'lavoro', fatte: fatte }); return; }
      var p = passi[st.passo];
      var modoRipresa = p.attivita && !st.aperta && fatte.indexOf(p.attivita.id) >= 0 ? 'ripresa' : 'lavoro';
      var box = palco.querySelector('.scelta-classe');
      box.innerHTML =
        '<h2>Sessione ' + esc(S) + '</h2>' +
        '<p class="sott">Interrotta al passo ' + (st.passo + 1) + ' di ' + passi.length + ': «' + esc(p.titolo || '') + '»' +
        (st.t ? ' · ' + esc(new Date(st.t).toLocaleString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })) : '') + '</p>' +
        '<div class="riga"><button type="button" class="riprendi">Riprendi dal passo ' + (st.passo + 1) + '</button>' +
        '<button type="button" class="dacapo">Dalla copertina</button>' +
        '<button type="button" class="altro">Altro codice</button></div>' +
        '<p class="aiuto">In entrambi i casi le risposte già date restano, e le attività già svolte si riaprono come ripresa. Riprendendo, mostra il QR con <b>Q</b>.</p>';
      box.querySelector('.riprendi').onclick = function () { avviaSessione(X, S, { passo: st.passo, f: 0, modo: modoRipresa, fatte: fatte }); };
      box.querySelector('.dacapo').onclick = function () { avviaSessione(X, S, { passo: 0, f: 0, modo: 'lavoro', fatte: fatte }); };
      box.querySelector('.altro').onclick = function () { schermataCodice(X); };
      box.querySelector('.riprendi').focus();
    }).catch(function () {
      schermataCodice(X, 'Database non raggiungibile: non posso sapere se la sessione ' + S + ' esiste già. Controlla la rete e riprova.');
    });
  }

  function avviaSessione(X, S, posIniziale) {
    var cfg = X.cfg, db = X.db, passi = cfg.passi;
    var chiaveP = 'aula:' + cfg.percorso + ':' + S + ':pos';
    var pos = posIniziale || { passo: 0, f: 0, modo: 'lavoro' };
    if (!(pos.passo < passi.length)) pos = { passo: 0, f: 0, modo: 'lavoro' };
    pos.fatte = pos.fatte || [];
    var timers = leggiLS('aula:' + cfg.percorso + ':' + S + ':timer', {});
    var collegati = 0, connOk = null, smetti = [], inizioLezione = null;

    document.body.className = 'aula-proiezione';
    document.body.innerHTML = '';
    var cornice = el('div', 'aula-cornice'), palco = el('div', 'aula-palco');
    cornice.appendChild(palco); document.body.appendChild(cornice);
    var nav = el('div', 'aula-nav', '<button type="button" aria-label="Indietro">‹</button><button type="button" aria-label="Avanti">›</button>');
    nav.children[0].onclick = function () { indietro(); }; nav.children[1].onclick = function () { avanti(); };
    document.body.appendChild(nav);

    function scala() {
      var s = Math.min(window.innerWidth / 1600, window.innerHeight / 900);
      palco.style.transform = 'translate(' + ((window.innerWidth - 1600 * s) / 2) + 'px,' + ((window.innerHeight - 900 * s) / 2) + 'px) scale(' + s + ')';
    }
    window.addEventListener('resize', scala); scala();

    var urlIngresso = location.origin + location.pathname + '?v=dispositivo&s=' + encodeURIComponent(S) +
      (X.dbParam ? '&db=' + encodeURIComponent(X.dbParam) : '');

    db.onConn = function (ok) { if (ok !== connOk) { connOk = ok; aggiornaPiede(); } };
    var presenze = db.ascolta('sessioni/' + S + '/presenze', function (d) { collegati = valori(d).length; aggiornaPiede(); aggiornaCopertina(); });

    function maxF(p) {
      var m = 0, tmp = el('div'); tmp.innerHTML = p.html || '';
      tmp.querySelectorAll('[data-f]').forEach(function (e) { m = Math.max(m, +e.getAttribute('data-f')); });
      return m;
    }
    function salva() { scriviLS(chiaveP, pos); }
    function pubblicaStato() {
      var p = passi[pos.passo];
      db.put('sessioni/' + S + '/stato', {
        passo: pos.passo, attivita: p.attivita ? p.attivita.id : null,
        aperta: !!(p.attivita && pos.modo === 'lavoro'), t: Date.now()
      }).catch(function () {});
    }

    var piede, timerEl, tick = null;
    function aggiornaPiede() {
      if (!piede) return;
      var dot = piede.querySelector('.punto');
      dot.className = 'punto' + (connOk === true ? ' ok' : connOk === false ? ' ko' : '');
      piede.querySelector('.coll').textContent = !db.attivo ? 'senza database' :
        connOk === false ? 'database non raggiungibile' : collegati + ' ' + nomi(cfg)[collegati === 1 ? 0 : 1];
    }
    function aggiornaCopertina() {
      var c = palco.querySelector('.copertina .ncoll');
      if (c) c.textContent = collegati;
    }

    function render() {
      smetti.forEach(function (f) { f(); }); smetti = [];
      if (tick) { clearInterval(tick); tick = null; }
      var p = passi[pos.passo];
      palco.innerHTML = '';
      var t = el('div', 'aula-testata'); t.appendChild(el('h1', '', p.titolo || cfg.titolo)); palco.appendChild(t);
      var corpo = el('div', 'aula-corpo'); palco.appendChild(corpo);
      piede = el('div', 'aula-piede',
        '<span class="avanzamento">' + (pos.passo + 1) + ' / ' + passi.length + '</span>' +
        '<span class="stato-conn"><i class="punto"></i><span class="coll"></span></span>' +
        '<span>sessione <b>' + esc(S) + '</b></span>' +
        '<span class="firma">' + esc(cfg.firma || 'francescobaldassarre') + '</span>');
      palco.appendChild(piede); aggiornaPiede();

      if (p.tipo === 'copertina') renderCopertina(corpo, p);
      else if (p.attivita) renderAttivita(corpo, p, p.attivita, pos.modo);
      else if (p.risultatiDi) renderAttivita(corpo, p, X.attivita[p.risultatiDi], 'ripresa', true);
      else corpo.innerHTML = p.html || '';

      corpo.querySelectorAll('[data-f]').forEach(function (e) {
        e.classList.toggle('aula-f-off', +e.getAttribute('data-f') > pos.f);
      });
      if (pannelloNote && !pannelloNote.classList.contains('aula-nascosto')) riempiNote();
      if (pos.passo > 0 && !inizioLezione) inizioLezione = Date.now();
      salva();
    }

    function renderCopertina(corpo, p) {
      var file = location.protocol === 'file:';
      corpo.innerHTML =
        '<div class="copertina"><div>' +
        '<h2>' + esc(cfg.titolo) + '</h2><p class="sott">' + esc(cfg.sottotitolo || '') + '</p>' +
        '<div class="dati">Inquadrate il codice QR con il telefono.<br>Codice della sessione: <span class="codice">' + esc(S) + '</span><br>' +
        (cfg.squadre ? 'Squadre collegate' : 'Dispositivi collegati') + ': <b class="ncoll">' + collegati + '</b></div>' +
        (file ? '<div class="avviso">Il file è aperto dal disco (file://): il QR funziona solo quando la lezione è pubblicata in rete.</div>' : '') +
        (!db.attivo ? '<div class="avviso">Nessun database configurato: le attività non raccoglieranno risposte.</div>' : '') +
        (p.html || '') +
        '<div class="comandi"><button type="button" class="nuova">Cambia classe</button> &nbsp; <span style="color:var(--tenue)">H: comandi · G: vai a un passo</span></div>' +
        '</div><div class="qr">' + qrSvg(urlIngresso) + '</div></div>';
      corpo.querySelector('.nuova').onclick = function () {
        var u = new URL(location.href); u.searchParams.delete('s'); location.href = u.toString();
      };
    }

    function renderAttivita(corpo, p, att, modo, soloLettura) {
      var comp = C[att.tipo];
      var w = el('div', 'att');
      if (p.html) { var cons = el('div'); cons.innerHTML = p.html; w.appendChild(cons); }
      var sotto = el('div', 'att-sotto');
      var salta = att.saltabile ? '<span class="saltabile">saltabile · S</span>' : '';
      if (comp.svelabile && !soloLettura) {
        sotto.innerHTML = modo === 'lavoro' ? '<span class="modo">Invii aperti</span><span>→ chiude gli invii</span>' + salta :
          !pos.svelata ? '<span class="modo ripresa">Invii chiusi · soluzione nascosta</span><span>→ svela · ← riapre gli invii</span>' + salta :
            '<span class="modo svelata">Soluzione svelata</span><span>→ passo successivo · ← nasconde</span>';
      } else
      sotto.innerHTML = soloLettura ? '<span class="modo ripresa">Risultati dell\'attività precedente</span>' :
        modo === 'lavoro' ? '<span class="modo">Attività aperta sui dispositivi</span><span>→ avanti: chiude e passa alla ripresa</span>' :
          '<span class="modo ripresa">Ripresa · attività chiusa</span><span>← indietro: riapre</span>';
      w.appendChild(sotto);
      var ris = el('div', 'att-risultati'); w.appendChild(ris);
      corpo.appendChild(w);
      var dati = null, datiC = null;
      var ctx = { modo: modo, sessione: S, datiConfronto: null, svelata: !soloLettura && modo === 'ripresa' && !!pos.svelata };
      var disegna = function () { ctx.datiConfronto = datiC; comp.proiezione(ris, att, dati, ctx); };
      disegna();
      smetti.push(db.ascolta('sessioni/' + S + '/risposte/' + att.id, function (d) { dati = d; disegna(); }));
      if (att.confronta) smetti.push(db.ascolta('sessioni/' + S + '/risposte/' + att.confronta, function (d) { datiC = d; disegna(); }));
      if (!soloLettura && att.minuti && modo === 'lavoro') avviaTimer(att);
    }

    function avviaTimer(att) {
      var tm = timers[att.id] || (timers[att.id] = { durata: att.minuti * 60, trascorso: 0, ultimo: Date.now(), pausa: false });
      tm.ultimo = Date.now();
      timerEl = el('div', 'aula-timer'); palco.appendChild(timerEl);
      var fineSegnata = false;
      var aggiorna = function () {
        var ora = Date.now();
        if (!tm.pausa) tm.trascorso += (ora - tm.ultimo) / 1000;
        tm.ultimo = ora;
        var resto = tm.durata - tm.trascorso;
        timerEl.textContent = mmss(resto);
        timerEl.className = 'aula-timer' + (tm.pausa ? ' pausa' : '') + (resto <= 0 ? ' fine' : '');
        if (resto <= 0 && !fineSegnata) fineSegnata = true;
        scriviLS('aula:' + cfg.percorso + ':' + S + ':timer', timers);
      };
      aggiorna(); tick = setInterval(aggiorna, 500);
      timerEl.onclick = function () { tm.pausa = !tm.pausa; aggiorna(); };
      timerEl._tm = tm; timerEl._agg = aggiorna;
    }

    // un'attività già chiusa in questa sessione si ripresenta come ripresa, non si riapre da sola
    function modoPer(n) {
      var q = passi[n];
      return q.attivita && pos.fatte.indexOf(q.attivita.id) >= 0 ? 'ripresa' : 'lavoro';
    }
    function avanti() {
      var p = passi[pos.passo];
      if (pos.f < maxF(p)) { pos.f++; aggiornaFrammenti(); salva(); return; }
      if (p.attivita && pos.modo === 'lavoro') {
        if (pos.fatte.indexOf(p.attivita.id) < 0) pos.fatte.push(p.attivita.id);
        pos.modo = 'ripresa'; pos.svelata = false; render(); pubblicaStato(); return;
      }
      if (p.attivita && pos.modo === 'ripresa' && C[p.attivita.tipo].svelabile && !pos.svelata) { pos.svelata = true; render(); return; }
      if (pos.passo < passi.length - 1) { pos.passo++; pos.f = 0; pos.svelata = false; pos.modo = modoPer(pos.passo); render(); pubblicaStato(); }
    }
    function indietro() {
      var p = passi[pos.passo];
      if (pos.svelata && p.attivita && pos.modo === 'ripresa') { pos.svelata = false; render(); return; }
      if (p.attivita && pos.modo === 'ripresa') { pos.modo = 'lavoro'; render(); pubblicaStato(); return; }
      if (pos.f > 0) { pos.f--; aggiornaFrammenti(); salva(); return; }
      if (pos.passo > 0) {
        pos.passo--; var q = passi[pos.passo];
        pos.f = maxF(q); pos.modo = q.attivita ? 'ripresa' : 'lavoro';
        pos.svelata = !!(q.attivita && C[q.attivita.tipo].svelabile);
        render(); pubblicaStato();
      }
    }
    function vai(n) { pos.passo = Math.max(0, Math.min(passi.length - 1, n)); pos.f = 0; pos.svelata = false; pos.modo = modoPer(pos.passo); render(); pubblicaStato(); }
    function aggiornaFrammenti() {
      palco.querySelectorAll('[data-f]').forEach(function (e) { e.classList.toggle('aula-f-off', +e.getAttribute('data-f') > pos.f); });
    }

    // sovrapposizioni
    var velo = el('div', 'aula-velo aula-nascosto'); document.body.appendChild(velo);
    velo.onclick = function () { velo.classList.add('aula-nascosto'); };
    var pannelloNote = el('div', 'aula-pannello aula-note aula-nascosto'); document.body.appendChild(pannelloNote);
    function riempiNote() {
      var p = passi[pos.passo];
      var trasc = inizioLezione ? mmss((Date.now() - inizioLezione) / 1000) : '0:00';
      pannelloNote.innerHTML = '<h4>Note per il docente · passo ' + (pos.passo + 1) + (p.minuti ? '<span class="min">' + p.minuti + ' min</span>' : '') + '</h4>' +
        (p.note || '<p><i>Nessuna nota.</i></p>') +
        '<p style="color:var(--tenue);margin-top:10px">Tempo dall\'inizio: ' + trasc + ' · N per chiudere</p>';
    }
    var pannelloQR = el('div', 'aula-pannello aula-qr-grande aula-nascosto'); document.body.appendChild(pannelloQR);
    pannelloQR.onclick = function () { pannelloQR.classList.add('aula-nascosto'); };
    var aiuto = el('div', 'aula-pannello aula-aiuto aula-nascosto',
      '<b>Comandi</b><br>' +
      '<kbd>→</kbd> <kbd>PagGiù</kbd> <kbd>Spazio</kbd> avanti · <kbd>←</kbd> <kbd>PagSu</kbd> indietro<br>' +
      '<kbd>Home</kbd> <kbd>Fine</kbd> primo / ultimo passo · <kbd>G</kbd> vai a un passo<br>' +
      'Le attività già chiuse si ripresentano come ripresa: <kbd>←</kbd> per riaprirle<br>' +
      '<kbd>B</kbd> <kbd>.</kbd> schermo nero · <kbd>F</kbd> schermo intero<br>' +
      '<kbd>N</kbd> note del docente · <kbd>Q</kbd> codice QR grande<br>' +
      '<kbd>T</kbd> ferma/riprende il timer · <kbd>+</kbd> un minuto in più<br>' +
      'Quiz: <kbd>→</kbd> chiude gli invii, <kbd>→</kbd> svela, <kbd>→</kbd> avanti · <kbd>S</kbd> salta al passo successivo<br>' +
      'Muro delle risposte: clic evidenzia, Maiusc+clic nasconde (solo qui)<br><kbd>H</kbd> chiude');
    document.body.appendChild(aiuto);
    aiuto.onclick = function () { aiuto.classList.add('aula-nascosto'); };
    var elenco = el('div', 'aula-pannello aula-elenco aula-nascosto'); document.body.appendChild(elenco);
    function apriElenco() {
      elenco.innerHTML = '<b>Vai a un passo</b> <span style="color:var(--tenue)">· G o Esc per chiudere</span><ol>' +
        passi.map(function (q, i) {
          var segno = q.attivita ? (pos.fatte.indexOf(q.attivita.id) >= 0 ? ' <span class="fatta">✓ attività svolta</span>' : ' <span class="dafare">attività</span>') : '';
          if (q.attivita && q.attivita.saltabile) segno += ' <span class="dafare">saltabile</span>';
          return '<li' + (i === pos.passo ? ' class="qui"' : '') + '><button type="button" data-n="' + i + '">' + (i + 1) + '. ' + esc(q.titolo || cfg.titolo) + segno + '</button></li>';
        }).join('') + '</ol>';
      elenco.querySelectorAll('button[data-n]').forEach(function (b) {
        b.onclick = function () { elenco.classList.add('aula-nascosto'); vai(+b.getAttribute('data-n')); };
      });
      elenco.classList.remove('aula-nascosto');
      var qui = elenco.querySelector('.qui button'); if (qui) qui.focus();
    }

    document.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      var k = e.key;
      if (!elenco.classList.contains('aula-nascosto')) {
        // nell'elenco dei passi: frecce su/giù tra le voci, Invio sceglie, G o Esc chiude
        if (k === 'g' || k === 'G' || k === 'Escape') { elenco.classList.add('aula-nascosto'); e.preventDefault(); return; }
        if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'PageDown' || k === 'PageUp') {
          var bs = [].slice.call(elenco.querySelectorAll('button[data-n]')), i = bs.indexOf(document.activeElement);
          i = (k === 'ArrowDown' || k === 'PageDown') ? Math.min(bs.length - 1, i + 1) : Math.max(0, i - 1);
          bs[i].focus(); e.preventDefault(); return;
        }
        return; // Invio sul pulsante a fuoco fa il resto
      }
      if (k === 'g' || k === 'G') { apriElenco(); e.preventDefault(); return; }
      if (!velo.classList.contains('aula-nascosto') && k !== 'F5') { velo.classList.add('aula-nascosto'); e.preventDefault(); return; }
      if (k === 'ArrowRight' || k === 'PageDown' || k === ' ' || k === 'Enter' || k === 'ArrowDown') { e.preventDefault(); avanti(); }
      else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'Backspace' || k === 'ArrowUp') { e.preventDefault(); indietro(); }
      else if (k === 'Home') vai(0);
      else if (k === 's' || k === 'S') { if (pos.passo < passi.length - 1) vai(pos.passo + 1); }
      else if (k === 'End') vai(passi.length - 1);
      else if (k === 'b' || k === 'B' || k === '.' || k === 'w' || k === 'W') velo.classList.remove('aula-nascosto');
      else if (k === 'f' || k === 'F') {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
        else document.exitFullscreen && document.exitFullscreen();
      }
      else if (k === 'n' || k === 'N') { pannelloNote.classList.toggle('aula-nascosto'); riempiNote(); }
      else if (k === 'q' || k === 'Q') {
        pannelloQR.innerHTML = qrSvg(urlIngresso) + '<div class="codice">' + esc(S) + '</div>';
        pannelloQR.classList.toggle('aula-nascosto');
      }
      else if (k === 'h' || k === 'H' || k === '?') aiuto.classList.toggle('aula-nascosto');
      else if ((k === 't' || k === 'T') && timerEl && timerEl._tm) { timerEl._tm.pausa = !timerEl._tm.pausa; timerEl._agg(); }
      else if (k === '+' && timerEl && timerEl._tm) { timerEl._tm.durata += 60; timerEl._agg(); }
      else if (k === 'Escape') { [pannelloNote, pannelloQR, aiuto].forEach(function (x) { x.classList.add('aula-nascosto'); }); }
    });

    render(); pubblicaStato();
    Aula._prova = { elenco: apriElenco, avanti: avanti, indietro: indietro, vai: vai, pos: function () { return pos; }, sessione: S, url: urlIngresso };
  }

  // ================================================================ DISPOSITIVO
  function avviaDispositivo(X) {
    var cfg = X.cfg, db = X.db, passi = cfg.passi;
    document.body.className = 'aula-dispositivo';
    document.body.innerHTML = '';
    var S = (param('s') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    var testata = el('div', 'disp-testata', '<div class="t">' + esc(cfg.titolo) + '</div><div class="c"></div>');
    var corpo = el('div', 'disp-corpo');
    document.body.appendChild(testata); document.body.appendChild(corpo);
    document.body.appendChild(el('div', 'disp-pie', cfg.squadre ?
      'La squadra entra con un codice casuale: nessun nome, nessun voto, nessuna classifica. Le risposte servono solo alla discussione in classe.' :
      'Entri con un codice casuale: nessun nome, nessun voto. Le risposte servono solo alla discussione in classe.'));

    if (!S) { chiediSessione(); return; }

    var chiaveC = 'aula:' + cfg.percorso + ':' + S + ':codice';
    var codice = leggiLS(chiaveC, null);
    if (!codice) { codice = casuale(5); scriviLS(chiaveC, codice); }
    testata.querySelector('.c').textContent = 'Sessione ' + S + (cfg.squadre ? ' · codice della squadra: ' : ' · il tuo codice: ') + codice;

    if (!db.attivo) { corpo.innerHTML = '<div class="disp-attesa">Questa lezione non ha un database configurato.</div>'; return; }
    db.put('sessioni/' + S + '/presenze/' + codice, Date.now()).catch(function () {});

    var chiaveR = 'aula:' + cfg.percorso + ':' + S + ':mie';
    var mie = leggiLS(chiaveR, {});
    var vista = null; // firma di ciò che è disegnato, per non cancellare ciò che lo studente sta scrivendo
    var conn = true;

    corpo.innerHTML = '<div class="disp-attesa"><div class="grande">Collegamento…</div></div>';
    db.onConn = function (ok) {
      if (ok === conn) return; conn = ok;
      var avv = document.querySelector('.disp-avviso-conn');
      if (!ok && !avv) { avv = el('div', 'disp-chiusa disp-avviso-conn', 'Connessione assente: riprovo da solo.'); corpo.prepend(avv); }
      if (ok && avv) avv.remove();
    };
    db.ascolta('sessioni/' + S + '/stato', function (st) {
      if (!st || st.passo == null) {
        if (vista !== 'attesa0') { vista = 'attesa0'; corpo.innerHTML = '<div class="disp-attesa"><div class="grande">Sei dentro.</div>Aspetta che il docente avvii la lezione.</div>'; }
        return;
      }
      var p = passi[st.passo] || {};
      var att = st.attivita ? X.attivita[st.attivita] : null;
      var firma = att ? 'a:' + att.id + ':' + (st.aperta ? 1 : 0) : p.riepilogo ? 'r:' + st.passo : p.dispositivo ? 'p:' + st.passo : 'w:' + st.passo;
      if (firma === vista) return;
      vista = firma;
      corpo.innerHTML = '';
      if (att) {
        if (!st.aperta) corpo.appendChild(el('div', 'disp-chiusa', 'Attività chiusa: guarda la proiezione, si commentano le risposte.'));
        var box = el('div');
        corpo.appendChild(box);
        if (att.testo) {
          var det = el('details', 'disp-lettura disp-testo-att');
          det.innerHTML = '<summary>Rileggi il testo</summary>' + att.testo;
          corpo.appendChild(det);
        }
        C[att.tipo].dispositivo(box, att, mie[att.id], function (val, esito, dopo) {
          if (!st.aperta) return;
          esito.className = 'disp-esito'; esito.textContent = 'Invio…';
          db.put('sessioni/' + S + '/risposte/' + att.id + '/' + codice, val).then(function () {
            mie[att.id] = val; scriviLS(chiaveR, mie);
            esito.className = 'disp-esito ok'; esito.textContent = 'Inviata ✓'; if (dopo) dopo();
          }).catch(function () {
            esito.className = 'disp-esito ko'; esito.textContent = 'Non inviata: controlla la connessione e riprova.';
          });
        });
        if (!st.aperta) box.querySelectorAll('button,textarea,input').forEach(function (x) { x.disabled = true; });
      } else if (p.riepilogo) {
        mostraRiepilogo();
      } else if (p.dispositivo) {
        var l = el('div', 'disp-lettura', p.dispositivo);
        corpo.appendChild(l);
      } else {
        corpo.innerHTML = '<div class="disp-attesa"><div class="grande">Segui la proiezione</div>' + esc(p.titolo || '') +
          '<br><br>Quando c\'è un\'attività, compare qui.</div>';
      }
      window.scrollTo(0, 0);
    });

    // riepilogo finale: tutte le domande del quiz con soluzione e spiegazione, e la risposta di questo dispositivo
    function mostraRiepilogo() {
      var quiz = passi.filter(function (q) { return q.attivita && q.attivita.tipo === 'quiz'; }).map(function (q) { return q.attivita; });
      var disegna = function (dalDb) {
        corpo.innerHTML = '';
        corpo.appendChild(el('div', 'disp-chiusa', 'Le domande con le soluzioni. Nessun punteggio: servono per rileggere e capire.'));
        quiz.forEach(function (a, n) {
          var mia = rispostaQuiz(mie[a.id], a.opzioni.length) || rispostaQuiz(dalDb && dalDb[a.id] && dalDb[a.id][codice], a.opzioni.length);
          var c = el('div', 'disp-card disp-riep');
          var h = '<h2>' + (n + 1) + '. ' + esc(a.domanda) + '</h2><ul>';
          a.opzioni.forEach(function (o, i) {
            h += '<li class="' + (i === a.giusta ? 'giusta' : '') + (mia && mia.r === i ? ' vostra' : '') + '"><b class="lettera">' + LETTERE[i] + '</b><span class="tx">' + esc(o) +
              (mia && mia.r === i ? ' <span class="et">la vostra</span>' : '') + '</span></li>';
          });
          h += '</ul><p class="spieg"><b>Giusta: ' + LETTERE[a.giusta] + '.</b> ' + esc(a.spiegazione || '') +
            (a.rimando ? ' <span class="rimando">' + esc(a.rimando) + '</span>' : '') + '</p>';
          c.innerHTML = h; corpo.appendChild(c);
        });
      };
      disegna(null);
      db.leggi('sessioni/' + S + '/risposte').then(disegna).catch(function () { /* restano quelle locali */ });
    }

    function chiediSessione() {
      testata.querySelector('.c').textContent = 'Inserisci il codice della sessione';
      corpo.innerHTML = '<div class="disp-card disp-ingresso"><h2>Codice della sessione</h2>' +
        '<p class="istr">È scritto sotto il QR, sulla proiezione.</p><input type="text" maxlength="8" autocomplete="off" autocapitalize="characters">' +
        '<button type="button" class="disp-invia">Entra</button></div>';
      var i = corpo.querySelector('input');
      corpo.querySelector('button').onclick = function () {
        var v = i.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (v.length < 3) return;
        var u = new URL(location.href); u.searchParams.set('s', v); u.searchParams.set('v', 'dispositivo'); location.href = u.toString();
      };
    }
  }

  // ================================================================ DOCENTE (da non proiettare)
  // Segue la proiezione (passo corrente) oppure mostra l'attività scelta; legge soltanto.
  function avviaDocente(X) {
    var cfg = X.cfg, db = X.db, passi = cfg.passi;
    document.body.className = 'aula-dispositivo aula-docente';
    document.body.innerHTML = '';
    var S = pulisciCodice(param('s'));
    var testata = el('div', 'disp-testata', '<div class="t">Vista docente · da non proiettare</div><div class="c">' + esc(cfg.titolo) + '</div>');
    var corpo = el('div', 'disp-corpo');
    document.body.appendChild(testata); document.body.appendChild(corpo);
    if (!RE_CODICE.test(S)) {
      corpo.innerHTML = '<div class="disp-card disp-ingresso"><h2>Codice della classe</h2><p class="istr">Lo stesso usato sulla proiezione.</p>' +
        '<input type="text" maxlength="8" autocomplete="off" autocapitalize="characters"><button type="button" class="disp-invia">Apri</button></div>';
      var i = corpo.querySelector('input');
      corpo.querySelector('button').onclick = function () {
        var v = pulisciCodice(i.value); if (!RE_CODICE.test(v)) return;
        var u = new URL(location.href); u.searchParams.set('s', v); u.searchParams.set('v', 'docente'); location.href = u.toString();
      };
      return;
    }
    testata.querySelector('.c').textContent = 'Sessione ' + S + ' · ' + cfg.titolo;
    var conDocente = [];
    passi.forEach(function (p, n) { if (p.attivita && C[p.attivita.tipo].docente) conDocente.push({ n: n, att: p.attivita }); });
    var stato = null, risposte = null, scelta = null; // scelta: id fissato a mano; null = segue la proiezione
    var barra = el('div', 'doc-barra'), box = el('div', 'disp-card doc-box'), avviso = el('div', 'disp-chiusa');
    corpo.appendChild(barra); corpo.appendChild(avviso); corpo.appendChild(box);
    function corrente() {
      if (scelta) return scelta;
      var p = stato && passi[stato.passo];
      return p && p.attivita && C[p.attivita.tipo].docente ? p.attivita.id : null;
    }
    function disegna() {
      var id = corrente();
      barra.innerHTML = '<button type="button" data-id="" class="' + (scelta ? '' : 'scelto') + '">Segui</button>' +
        conDocente.map(function (x, k) {
          return '<button type="button" data-id="' + esc(x.att.id) + '" class="' + (id === x.att.id ? 'scelto' : '') + (x.att.saltabile ? ' salt' : '') + '">' + (k + 1) + '</button>';
        }).join('');
      barra.querySelectorAll('button').forEach(function (b) { b.onclick = function () { scelta = b.getAttribute('data-id') || null; disegna(); }; });
      var p = stato && passi[stato.passo];
      avviso.textContent = stato ? 'Proiezione al passo ' + (stato.passo + 1) + ' · ' + (p && p.titolo || '') + (stato.aperta ? ' · invii aperti' : '') : 'La proiezione non ha ancora avviato la sessione.';
      if (!id) { box.innerHTML = '<p class="disp-attesa">Sul passo proiettato non c\'è una domanda. Scegli un numero qui sopra.</p>'; return; }
      var att = X.attivita[id];
      C[att.tipo].docente(box, att, risposte && risposte[id]);
    }
    db.ascolta('sessioni/' + S + '/stato', function (d) { stato = d; disegna(); });
    db.ascolta('sessioni/' + S + '/risposte', function (d) { risposte = d; disegna(); });
    disegna();
  }

  window.Aula = Aula;
})();
