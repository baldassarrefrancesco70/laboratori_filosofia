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
 * Parametri URL utili: v=dispositivo · s=<sessione> · db=<url database> (solo per prove)
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
      var wrap = el('div', 'barre');
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

  Aula.avvia = function (cfg) {
    var dbUrl = param('db') || cfg.database;
    var db = new DB(dbUrl, cfg.percorso);
    var attivita = {};
    cfg.passi.forEach(function (p) { if (p.attivita) attivita[p.attivita.id] = p.attivita; });
    var ctxBase = { cfg: cfg, db: db, attivita: attivita, dbParam: param('db') };
    document.title = cfg.titolo;
    if (param('v') === 'dispositivo') avviaDispositivo(ctxBase); else avviaProiezione(ctxBase);
  };

  // ================================================================ PROIEZIONE
  function avviaProiezione(X) {
    var cfg = X.cfg, db = X.db, passi = cfg.passi;
    var chiaveS = 'aula:' + cfg.percorso + ':sessione';
    var S = (param('s') || '').toUpperCase() || leggiLS(chiaveS, null);
    if (!S) { S = casuale(4); }
    scriviLS(chiaveS, S);
    var chiaveP = 'aula:' + cfg.percorso + ':' + S + ':pos';
    var pos = leggiLS(chiaveP, { passo: 0, f: 0, modo: 'lavoro' });
    if (pos.passo >= passi.length) pos = { passo: 0, f: 0, modo: 'lavoro' };
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
        connOk === false ? 'database non raggiungibile' : collegati + (collegati === 1 ? ' dispositivo' : ' dispositivi');
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
        'Dispositivi collegati: <b class="ncoll">' + collegati + '</b></div>' +
        (file ? '<div class="avviso">Il file è aperto dal disco (file://): il QR funziona solo quando la lezione è pubblicata in rete.</div>' : '') +
        (!db.attivo ? '<div class="avviso">Nessun database configurato: le attività non raccoglieranno risposte.</div>' : '') +
        (p.html || '') +
        '<div class="comandi"><button type="button" class="nuova">Nuova sessione (altra classe)</button> &nbsp; <span style="color:var(--tenue)">H: comandi</span></div>' +
        '</div><div class="qr">' + qrSvg(urlIngresso) + '</div></div>';
      corpo.querySelector('.nuova').onclick = function () {
        if (!confirm('Aprire una nuova sessione? Le risposte della sessione ' + S + ' restano nel database, ma questa proiezione non le mostrerà più.')) return;
        scriviLS(chiaveS, casuale(4));
        var u = new URL(location.href); u.searchParams.delete('s'); location.href = u.toString();
      };
    }

    function renderAttivita(corpo, p, att, modo, soloLettura) {
      var comp = C[att.tipo];
      var w = el('div', 'att');
      if (p.html) { var cons = el('div'); cons.innerHTML = p.html; w.appendChild(cons); }
      var sotto = el('div', 'att-sotto');
      sotto.innerHTML = soloLettura ? '<span class="modo ripresa">Risultati dell\'attività precedente</span>' :
        modo === 'lavoro' ? '<span class="modo">Attività aperta sui dispositivi</span><span>→ avanti: chiude e passa alla ripresa</span>' :
          '<span class="modo ripresa">Ripresa · attività chiusa</span><span>← indietro: riapre</span>';
      w.appendChild(sotto);
      var ris = el('div', 'att-risultati'); w.appendChild(ris);
      corpo.appendChild(w);
      var dati = null, datiC = null;
      var ctx = { modo: modo, sessione: S, datiConfronto: null };
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

    function avanti() {
      var p = passi[pos.passo];
      if (pos.f < maxF(p)) { pos.f++; aggiornaFrammenti(); salva(); return; }
      if (p.attivita && pos.modo === 'lavoro') { pos.modo = 'ripresa'; render(); pubblicaStato(); return; }
      if (pos.passo < passi.length - 1) { pos.passo++; pos.f = 0; pos.modo = 'lavoro'; render(); pubblicaStato(); }
    }
    function indietro() {
      var p = passi[pos.passo];
      if (p.attivita && pos.modo === 'ripresa') { pos.modo = 'lavoro'; render(); pubblicaStato(); return; }
      if (pos.f > 0) { pos.f--; aggiornaFrammenti(); salva(); return; }
      if (pos.passo > 0) {
        pos.passo--; var q = passi[pos.passo];
        pos.f = maxF(q); pos.modo = q.attivita ? 'ripresa' : 'lavoro';
        render(); pubblicaStato();
      }
    }
    function vai(n) { pos.passo = Math.max(0, Math.min(passi.length - 1, n)); pos.f = 0; pos.modo = 'lavoro'; render(); pubblicaStato(); }
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
      '<kbd>Home</kbd> <kbd>Fine</kbd> primo / ultimo passo<br>' +
      '<kbd>B</kbd> <kbd>.</kbd> schermo nero · <kbd>F</kbd> schermo intero<br>' +
      '<kbd>N</kbd> note del docente · <kbd>Q</kbd> codice QR grande<br>' +
      '<kbd>T</kbd> ferma/riprende il timer · <kbd>+</kbd> un minuto in più<br>' +
      'Muro delle risposte: clic evidenzia, Maiusc+clic nasconde (solo qui)<br><kbd>H</kbd> chiude');
    document.body.appendChild(aiuto);
    aiuto.onclick = function () { aiuto.classList.add('aula-nascosto'); };

    document.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      var k = e.key;
      if (!velo.classList.contains('aula-nascosto') && k !== 'F5') { velo.classList.add('aula-nascosto'); e.preventDefault(); return; }
      if (k === 'ArrowRight' || k === 'PageDown' || k === ' ' || k === 'Enter' || k === 'ArrowDown') { e.preventDefault(); avanti(); }
      else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'Backspace' || k === 'ArrowUp') { e.preventDefault(); indietro(); }
      else if (k === 'Home') vai(0);
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
    Aula._prova = { avanti: avanti, indietro: indietro, vai: vai, pos: function () { return pos; }, sessione: S, url: urlIngresso };
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
    document.body.appendChild(el('div', 'disp-pie', 'Entri con un codice casuale: nessun nome, nessun voto. Le risposte servono solo alla discussione in classe.'));

    if (!S) { chiediSessione(); return; }

    var chiaveC = 'aula:' + cfg.percorso + ':' + S + ':codice';
    var codice = leggiLS(chiaveC, null);
    if (!codice) { codice = casuale(5); scriviLS(chiaveC, codice); }
    testata.querySelector('.c').textContent = 'Sessione ' + S + ' · il tuo codice: ' + codice;

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
      var firma = att ? 'a:' + att.id + ':' + (st.aperta ? 1 : 0) : p.dispositivo ? 'p:' + st.passo : 'w:' + st.passo;
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
      } else if (p.dispositivo) {
        var l = el('div', 'disp-lettura', p.dispositivo);
        corpo.appendChild(l);
      } else {
        corpo.innerHTML = '<div class="disp-attesa"><div class="grande">Segui la proiezione</div>' + esc(p.titolo || '') +
          '<br><br>Quando c\'è un\'attività, compare qui.</div>';
      }
      window.scrollTo(0, 0);
    });

    function chiediSessione() {
      testata.querySelector('.c').textContent = 'Inserisci il codice della sessione';
      corpo.innerHTML = '<div class="disp-card disp-ingresso"><h2>Codice della sessione</h2>' +
        '<p class="istr">È scritto sotto il QR, sulla proiezione.</p><input type="text" maxlength="6" autocomplete="off" autocapitalize="characters">' +
        '<button type="button" class="disp-invia">Entra</button></div>';
      var i = corpo.querySelector('input');
      corpo.querySelector('button').onclick = function () {
        var v = i.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (v.length < 4) return;
        var u = new URL(location.href); u.searchParams.set('s', v); u.searchParams.set('v', 'dispositivo'); location.href = u.toString();
      };
    }
  }

  window.Aula = Aula;
})();
