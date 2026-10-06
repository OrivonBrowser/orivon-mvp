# Informativa sulla privacy

Versione dell'informativa: 2

Orivon Browser tiene la cronologia della tua navigazione sul tuo computer. Questa pagina dice che cosa ne esce,
perché, e che cosa puoi fare. È scritta per chi usa il browser; l'elenco tecnico che la sostiene
è [`outbound-requests.md`](outbound-requests.md) (in inglese), e la versione in inglese di questa
informativa è [`notice.md`](notice.md), che è il testo di riferimento se le due differiscono.

> **In cinque righe**
>
> - La telemetria è **una tua scelta**: la prima schermata chiede con due pulsanti uguali, e le
>   Impostazioni hanno un interruttore. Se è spenta, non si misura e non si invia nulla.
> - Conta il **tempo**: per quanto usi il browser, e per quanto su siti Web3, Web2.5 e altri. Nomina
>   un sito solo se è un sito Web3 o Web2.5 con un nome pubblico.
> - **Non invia indirizzi di pagine, testi cercati o cronologia, e il tuo indirizzo IP non viene
>   mai scritto su disco.**
> - Va al **nostro server** (`telemetry.orivonstack.com`), gestito da noi, senza società di analisi
>   di mezzo.
> - Puoi **vedere esattamente che cosa viene inviato**, **spegnerla quando vuoi** e **cancellare
>   ciò che conserviamo** con un pulsante.

## Chi è responsabile

Il titolare del trattamento dei dati di telemetria è Davide Martinico, una persona fisica, il
proprietario del progetto. Per qualsiasi cosa in questa informativa scrivi a
privacy@orivonstack.com.

## Cosa invia la telemetria

Partono due messaggi, ciascuno circa una volta al giorno, con uno in più di ciascuno all'inizio
del mese per chiudere i totali del mese precedente, e un altro messaggio quando chiedi di
cancellare i tuoi dati. In Impostazioni > Privacy vedi il testo esatto di ciascuno, prima e dopo
l'invio.

| Campo | Messaggio | Che cos'è |
|---|---|---|
| `schema` | tutti | La versione del formato del messaggio, un numero |
| `installId` | rapporto d'uso, richiesta di cancellazione | Un identificativo di questo computer, di 32 caratteri. Deriva dall'ID macchina del sistema operativo passato in una funzione di hash a senso unico, quindi non si può risalire all'ID macchina. È lo stesso per tutti i profili del browser su questo computer, e per una versione avviata dai sorgenti e una installata. Viene creato solo dopo che attivi la telemetria |
| `stream` | rapporto d'uso | Un valore casuale creato una volta per ogni profilo del browser. Due profili aperti insieme vengono contati entrambi e sommati come un solo computer grazie all'ID di installazione, quindi non sono due persone |
| `region` | rapporto d'uso | `EU`, `US` oppure `other`, ricavato sul tuo computer dal suo fuso orario. Non viene mai preso dal tuo indirizzo IP |
| `version` | rapporto d'uso, rapporto sui siti | La versione di Orivon Browser |
| `period` | rapporto d'uso, rapporto sui siti | Il mese, per esempio `2026-10`. Il messaggio è un totale del mese finora, inviato di nuovo con un totale più grande nei giorni seguenti |
| `activeSec` | rapporto d'uso | Secondi del mese in cui usavi il browser: finestra in primo piano e tu attivo |
| `backgroundSec` | rapporto d'uso | Secondi del mese in cui il browser era in esecuzione senza che lo usassi |
| `classes.web3` | rapporto d'uso | Dei secondi attivi, quelli su siti Web3 (verificati per intero, senza un server che possa cambiare ciò che ricevi) |
| `classes.web25` | rapporto d'uso | Dei secondi attivi, quelli su siti Web2.5 (verificati in parte) |
| `classes.web2` | rapporto d'uso | Dei secondi attivi, quelli su normali siti Web2. Solo un totale: nessun sito viene nominato |
| `reportId` | rapporto sui siti | Un valore casuale creato per ogni profilo e ogni mese. Non è il tuo ID di installazione, e il mese dopo ne viene creato uno nuovo |
| `sites` | rapporto sui siti | Per ogni sito Web3 o Web2.5 con un nome pubblico, i secondi attivi nel mese |

Come è scritto `sites`. Ogni chiave è `web3:<nome>` o `web25:<nome>`, per esempio
`web3:vitalik.eth` o `web25:app.example.org`, e il suo valore è un numero di secondi. `<nome>`
viene inviato solo se è pubblico: un nome di dominio, un nome ENS, o un sito che il fornitore del
Web3 Score ha valutato. Un sito che ha solo un identificativo di contenuto grezzo, una chiave IPNS
o un indirizzo di rete locale o privata, senza un nome valutato, viene sommato al totale della sua
classe ed elencato come `(unlisted)`. I normali siti Web2 non vengono mai annotati, nemmeno sul
tuo computer: esistono solo dentro il totale `classes.web2`.

Che cosa resta fuori, detto chiaramente. Nessun indirizzo di pagina, nessun percorso, nessun testo
cercato, nessun titolo di pagina, nessun segnalibro, nessuna password, nessun nome di file,
nessun elenco dell'ordine o degli orari delle tue visite, nessun identificativo pubblicitario. Il
rapporto sui siti nomina siti Web3 e Web2.5 pubblici e i secondi trascorsi su ciascuno in un
mese: è la cosa più vicina a un'informazione di navigazione che inviamo, ed è quindi tenuto
separato dal tuo ID di installazione, come dice la tabella.

Inviato circa una volta al giorno, e una volta in più all'inizio del mese per chiudere i totali
del mese precedente. Non si invia nulla da una versione di sviluppo, da una
finestra privata, o quando è impostato `ORIVON_TELEMETRY=off`. Non si invia nulla prima che tu
scelga. Il browser ignora tutto ciò che il server risponde: il server non può cambiare
impostazioni né inviare comandi.

## Perché, e con quale base giuridica

**Finalità.** Capire se le persone usano davvero il browser, misurato in utenti attivi (attivo
significa 25 ore al mese), in Europa e negli Stati Uniti, e su quali tipi di sito passano il
tempo. Lo usiamo per decidere che cosa costruire e per valutare il progetto. Non lo usiamo per
pubblicità, profilazione o vendita, e non lo diamo a nessuno.

**Base giuridica.** Il tuo consenso: articolo 6, paragrafo 1, lettera a) del GDPR. Leggere l'ID
macchina dal tuo computer e conservarvi un identificativo richiede il tuo consenso anche ai sensi
dell'articolo 5, paragrafo 3 della direttiva ePrivacy, e la stessa risposta lo dà. La prima
schermata mostra un blocco intitolato **Telemetria** con due pulsanti uguali per aspetto e
dimensione, **Entra e condividi la telemetria** e **Entra senza telemetria**. Nessuno è
preselezionato e per entrare devi premerne uno: la tua risposta è quindi un atto chiaro, non una
casella lasciata com'era. Il blocco compare solo finché non hai risposto. Puoi cambiare idea in
qualsiasi momento con l'interruttore nelle Impostazioni; revocare è facile quanto acconsentire, e
il browser non peggiora in nulla. Se hai risposto di no, nulla te lo richiede per sei mesi.

**Un identificativo è un dato personale?** Sì, lo trattiamo come tale. Da esso non possiamo sapere
chi sei, ma con esso possiamo ritrovare le tue righe: per questo è protetto come un dato personale
e per questo puoi chiederci di cancellarle.

## Che cosa conserviamo, e per quanto tempo

- **Righe d'uso**, una per computer, profilo e mese: 12 mesi, poi restano solo totali che non si
  possono ricondurre a un computer (il numero di utenti attivi, la ripartizione per regione e per
  classe).
- **Rapporti sui siti**: un elenco di siti con i secondi, conservato per il mese; un mese dopo
  la chiusura del mese viene ridotto a totali per sito per tutti gli utenti insieme, e i singoli
  rapporti vengono cancellati.
- **Il tuo indirizzo IP e lo User-Agent**: non vengono scritti su disco. Il front end web che
  chiude la connessione cifrata non tiene alcun registro degli accessi. L'indirizzo resta solo in
  memoria, per limitare ogni indirizzo a 30 richieste in 10 minuti, e si perde al riavvio.
- **Momento di ricezione**: con una riga si conserva solo il giorno UTC, non l'ora.

## Chi lo riceve, e dove va

Solo noi. Non c'è un responsabile del trattamento né una società di analisi. Il server è nostro,
su `telemetry.orivonstack.com`, su un server virtuale preso in affitto da OVH SAS a Strasburgo,
in Francia. Le righe stanno in un database su quel server. Nulla esce dall'UE. Se cambia,
cambia prima questa informativa e il numero di versione in alto aumenta: il consenso dato prima
smette di valere finché non la riattivi nelle Impostazioni. Il codice sorgente del server non è pubblicato;
questa informativa è la descrizione di ciò che conserva e per quanto tempo.

## I tuoi diritti

- **Vedere che cosa viene inviato.** Impostazioni > Privacy mostra entrambi i messaggi e un
  elenco di ciò che è stato inviato.
- **Accesso** alle righe che conserviamo: scrivi a privacy@orivonstack.com indicando l'ID di installazione
  mostrato nelle Impostazioni.
- **Cancellazione.** Premi **Cancella i miei dati** nelle Impostazioni: chiede al server di
  cancellare ogni riga d'uso per il tuo ID di installazione, spegne la telemetria e dice se è
  riuscito. Puoi anche scrivere a privacy@orivonstack.com indicando il tuo ID. I rapporti sui
  siti non si possono cancellare tramite l'ID di installazione, perché non lo contengono mai,
  quindi non possiamo trovare il tuo tra gli altri; escono come parte dei totali mensili per
  sito descritti sopra.
- **Revocare il consenso** in qualsiasi momento nelle Impostazioni.
- **Opposizione, rettifica, limitazione, portabilità.** Scrivi a privacy@orivonstack.com; i dati sono solo
  contatori, quindi rettifica e portabilità hanno poco su cui agire, ma risponderemo.
- **Reclamo** a un'autorità per la protezione dei dati. In Italia è il Garante per la protezione
  dei dati personali, `garanteprivacy.it`; puoi scegliere l'autorità del paese in cui vivi o
  lavori.

## Tutto il resto che il browser invia da solo

La telemetria è l'unica cosa che arriva a un nostro server. Il browser fa anche richieste proprie
ad altri server, che non gestiamo e da cui non riceviamo nulla. Ciascuna è in
[`outbound-requests.md`](outbound-requests.md) con il file che la effettua.

| Che cosa | A chi | Perché, e base giuridica | Puoi |
|---|---|---|---|
| Controllare se c'è una nuova versione | `api.github.com` | Per dirti che esiste un aggiornamento. Il tuo consenso: è spento finché non lo attivi in Impostazioni > Informazioni | Spegnerlo |
| Seguire Ethereum e dimostrare i nomi `.eth` | `eth.drpc.org`, `rpc.mevblocker.io`, `ethereum-rpc.publicnode.com`, `ethereum-beacon-api.publicnode.com` | Per verificare un nome invece di fidarsi di un server. Serve alla funzione che hai chiesto aprendo un indirizzo `.eth` o `ipfs://`; due minuti dopo l'avvio rinnova anche un checkpoint più vecchio di una settimana (nostro legittimo interesse, art. 6(1)(f), che la funzione lavori). L'RPC vede quale nome `.eth` apri | Spegnere il light client in Impostazioni > Web3 (poi nessun nome `.eth` si carica) |
| Scaricare il contenuto di un indirizzo `ipfs://` o di un sito `.eth`, e cercare chiavi `ipns://` e nomi DNSLink | `ipfs.orbitor.dev`, `ipfs.filebase.io`, `trustless-gateway.link`, `name.web3.storage`, `cloudflare-dns.com`, `dns.google`, e per alcuni nomi un server scelto dal record del nome stesso | Per aprire l'indirizzo che hai chiesto. Esecuzione di ciò che hai chiesto, art. 6(1)(b). Il server vede quale contenuto apri. Ogni blocco è verificato contro il suo hash | Non aprire tali indirizzi |
| Controllare se un'app installata ha una nuova versione mentre la sua scheda è aperta | Gli stessi server, ogni 30 minuti | Per dirti quando un'app che hai installato ha una nuova versione. Nostro legittimo interesse, art. 6(1)(f), a tenere le app aggiornate e sicure; ripete le richieste della riga precedente | Chiudere la scheda dell'app |
| Interrogare il fornitore del Web3 Score sulla pagina in cui sei | Il fornitore impostato in Impostazioni > Web3 (di default uno scelto da Orivon, a un indirizzo IPNS) | Per mostrare un livello di fiducia nello scudo del sito. Legittimo interesse, art. 6(1)(f); attivo di default. Il fornitore apprende un gruppo (bucket), 1 su 16 o 256, in cui cade l'identificativo di contenuto della pagina, mai l'identificativo né l'indirizzo. Un fornitore che conosce pochi siti può indovinare a quale gruppo si riferisce | Svuotare l'indirizzo del fornitore in Impostazioni > Web3 |
| Scaricare l'icona di una pagina | L'host del sito stesso, o un host che il sito indica | Per disegnare l'icona della scheda. Esecuzione di ciò che hai chiesto, art. 6(1)(b); lo stesso host che ha servito la pagina | Non è possibile |
| Controllare gli aggiornamenti delle estensioni del Web Store | `update.googleapis.com` | Per tenere aggiornate e sicure le estensioni che hai installato. Legittimo interesse, art. 6(1)(f), e solo se ne hai installata una. Invia i loro identificativi, la versione di Chromium, il tuo sistema operativo e due identificativi casuali. Mai in una finestra privata | Rimuovere l'estensione |
| I download propri di un'estensione, come le liste di filtri | Gli host che l'estensione indica | Deciso dall'estensione che hai installato | Le impostazioni dell'estensione, o rimuoverla |
| Scaricare un dizionario del correttore ortografico, una volta per lingua | L'host dei dizionari di Chromium | Per correggere la tua ortografia. Esecuzione di ciò che hai chiesto, art. 6(1)(b), e le Impostazioni lo dicono | Spegnere il correttore ortografico |

Altre tre cose non inviano nulla finché non le attivi nelle Impostazioni: i suggerimenti di
ricerca mentre digiti (il testo digitato va al tuo motore di ricerca; mai in una finestra
privata), il DNS sicuro (ogni nome di sito va al risolutore che scegli), e i segnali Do Not Track
e Global Privacy Control, che non inviano dati propri.

Non controlliamo che cosa facciano quei server con la connessione. Vedono il tuo indirizzo IP,
come ogni server a cui ti colleghi, e hanno proprie informative sulla privacy.

## Do Not Track e Global Privacy Control

Orivon Browser non ti traccia tra un sito e l'altro e non fa pubblicità. **Global Privacy
Control** è attivo finché non lo spegni nelle Impostazioni: ogni sito che visiti riceve `Sec-GPC: 1`
nelle sue richieste e legge `navigator.globalPrivacyControl` come `true`, e questo gli chiede di
non vendere né condividere i tuoi dati. **Do Not Track** è spento finché non lo attivi; allora il
browser aggiunge `DNT: 1`. La telemetria
di Orivon non guarda quei segnali: segue la scelta sulla telemetria che fai nel browser, che è più
rigorosa, perché è sempre la tua risposta esplicita.

## Modifiche

Quando un messaggio cambia o ne viene aggiunto uno, il numero di versione in alto aumenta. Un
consenso dato con una versione precedente smette di valere: non si invia nulla finché non riattivi
la telemetria nelle Impostazioni.
