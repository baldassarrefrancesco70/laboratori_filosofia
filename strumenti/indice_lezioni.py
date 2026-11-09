#!/usr/bin/env python3
"""Rigenera lezioni/indice.json leggendo i campi <meta name="portale:..."> e il percorso Firebase
di ogni lezione in lezioni/*.html. Lo esegue l'azione GitHub «indice-lezioni» a ogni caricamento;
si può lanciare anche a mano: python3 strumenti/indice_lezioni.py"""
import json, re, pathlib, sys

RADICE = pathlib.Path(__file__).resolve().parent.parent
CARTELLA = RADICE / 'lezioni'
META = re.compile(r'<meta\s+name="portale:([a-z]+)"\s+content="([^"]*)"\s*/?>', re.I)
PERCORSO = re.compile(r"percorso:\s*['\"]([A-Za-z0-9_]+)['\"]")

def leggi(f):
    testo = f.read_text(encoding='utf-8')
    campi = {k.lower(): v for k, v in META.findall(testo)}
    if campi.get('tipologia') != 'lezione':
        return None
    m = PERCORSO.search(testo)
    return {
        'file': f.name,
        'titolo': campi.get('titolo') or f.stem,
        'materia': campi.get('materia', ''),
        'classe': campi.get('classe', ''),
        'descrizione': campi.get('descrizione', ''),
        'percorso': m.group(1) if m else '',
    }

def main():
    voci = [v for v in (leggi(f) for f in sorted(CARTELLA.glob('*.html')) if f.name != 'index.html') if v]
    voci.sort(key=lambda v: (v['materia'], v['classe'], v['file']))
    nuovo = json.dumps({'lezioni': voci}, ensure_ascii=False, indent=2) + '\n'
    dest = CARTELLA / 'indice.json'
    vecchio = dest.read_text(encoding='utf-8') if dest.exists() else ''
    if nuovo != vecchio:
        dest.write_text(nuovo, encoding='utf-8')
        print(f'indice.json aggiornato: {len(voci)} lezioni')
    else:
        print(f'indice.json invariato: {len(voci)} lezioni')
    senza = [v['file'] for v in voci if not v['classe'] or not v['percorso']]
    if senza:
        print('ATTENZIONE, manca portale:classe o percorso in:', ', '.join(senza), file=sys.stderr)

if __name__ == '__main__':
    main()
