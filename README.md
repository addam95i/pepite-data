# pepite-data

Données de l'appli **Pépite** : le radar des artistes hip-hop qui percent.

## Comment ça marche

1. Le robot (`.github/workflows/update.yml`) tourne **une fois par jour** (et à la demande avec « Run workflow »).
2. Il cherche sur YouTube les clips hip-hop FR des 14 derniers jours (`config/settings.json` › `queries`).
3. Il relève les abonnés de chaque chaîne et garde un historique de 90 jours (`data/history.json`).
4. Il garde les artistes entre 300 et **100 000 abonnés** et calcule le **score de percée** (0 à 100) :
   - vues par jour du dernier clip comparées au nombre d'abonnés ;
   - progression des abonnés sur 7 jours, dès qu'il y a une semaine d'historique.
5. Il ajoute les fans Deezer quand le nom correspond exactement.
6. Il écrit `public/radar.json`, que l'appli télécharge.

## Réglages (sans toucher au code)

Tout est dans `config/settings.json` :

- `threshold` : le seuil de sortie du radar (100 000).
- `queries` : les recherches YouTube faites chaque jour.
- `subgenres` : les mots qui classent un clip en Drill, Mélo, Trap…
- `exclude.channelWords` / `exclude.channelIds` : pour écarter les chaînes de médias, compilations, labels.

Chaque recherche coûte 100 unités de quota YouTube sur 10 000 par jour : 12 recherches × 2 pages = 2 400 unités.

## Secret nécessaire

`YOUTUBE_API_KEY` dans Settings › Secrets and variables › Actions.
