# FamilyCare Senior V1.0.68 Render Update

## Ce s-a modificat
- Eliminată tastatura numerică custom din modalul de apel.
- Eliminată tastatura text custom și mesajele rapide din modalul de SMS/alertă.
- Se folosește tastatura nativă a telefonului doar când utilizatorul apasă în câmp.
- Dacă există un singur număr configurat, se afișează doar acel număr, clar, ca singură alegere.
- Cache PWA actualizat la V1.0.68.

## Pași
1. Urcă tot conținutul arhivei în repo-ul `familycare-senior`, direct în root.
2. Commit changes.
3. Render -> familycare-senior -> Manual Deploy -> Clear build cache & deploy.
4. Pe telefon închide PWA/Chrome și redeschide. Dacă apare layout vechi, șterge PWA-ul și reinstalează.

Nu se rulează SQL. Nu se modifică Environment Variables.
