# Informativa sulla privacy

Versione dell'informativa: 4

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

Le segnalazioni di problemi sono separate dalla telemetria: una parte solo quando la scrivi e
premi Invia. Vedi [Le segnalazioni di problemi che invii](#le-segnalazioni-di-problemi-che-invii).

## Chi è responsabile

Il titolare del trattamento dei dati di telemetria e delle segnalazioni di problemi che invii è Davide Martinico, una persona fisica, il
proprietario del progetto. Per qualsiasi cosa in questa informativa scrivi a
privacy@orivonstack.com.

## Cosa invia la telemetria

Partono due messaggi: quando attivi la telemetria, quando apri e quando chiudi il browser, circa
una volta al giorno nel frattempo, e una volta in più all'inizio del mese per chiudere i totali del mese
precedente. Un altro messaggio parte quando chiedi di cancellare i tuoi dati. In Impostazioni > Privacy vedi il testo esatto di ciascuno, prima e dopo
l'invio.

| Campo | Messaggio | Che cos'è |
|---|---|---|
| `schema` | tutti | La versione del formato del messaggio, un numero |
| `installId` | rapporto d'uso, rapporto sui siti, richiesta di cancellazione | Un identificativo di questo computer, di 32 caratteri. Deriva dall'ID macchina del sistema operativo passato in una funzione di hash a senso unico, quindi non si può risalire all'ID macchina. È lo stesso per tutti i profili del browser su questo computer, e per una versione avviata dai sorgenti e una installata. Viene creato solo dopo che attivi la telemetria. Lo porta anche il rapporto sui siti, così i rapporti falsificati da un programma si distinguono dai tuoi |
| `stream` | rapporto d'uso, rapporto sui siti | Un valore casuale creato una volta per ogni profilo del browser. Due profili aperti insieme vengono contati entrambi e sommati come un solo computer grazie all'ID di installazione, quindi non sono due persone |
| `country` | rapporto d'uso | Il paese del fuso orario del tuo computer, come codice di due lettere quale `IT` o `US`, ricavato sul tuo computer dall'impostazione del fuso orario; `unknown` quando il fuso orario non indica un paese, come `UTC`. È il paese del fuso orario, non la prova di dove ti trovi, e non viene mai preso dal tuo indirizzo IP |
| `version` | rapporto d'uso, rapporto sui siti | La versione di Orivon Browser |
| `period` | rapporto d'uso, rapporto sui siti | Il mese, per esempio `2026-10`. Il messaggio è un totale del mese finora, inviato di nuovo con un totale più grande nei giorni seguenti |
| `activeSec` | rapporto d'uso | Secondi del mese in cui usavi il browser: finestra in primo piano e tu attivo |
| `backgroundSec` | rapporto d'uso | Secondi del mese in cui il browser era in esecuzione senza che lo usassi |
| `classes.web3` | rapporto d'uso | Dei secondi attivi, quelli su siti Web3 (verificati per intero, senza un server che possa cambiare ciò che ricevi) |
| `classes.web25` | rapporto d'uso | Dei secondi attivi, quelli su siti Web2.5 (verificati in parte) |
| `classes.web2` | rapporto d'uso | Dei secondi attivi, quelli su normali siti Web2. Solo un totale: nessun sito viene nominato |
| `sites` | rapporto sui siti | Per ogni sito Web3 o Web2.5 con un nome pubblico, i secondi attivi nel mese |

Come è scritto `sites`. Ogni chiave è `web3:<nome>` o `web25:<nome>`, per esempio
`web3:vitalik.eth` o `web25:app.example.org`, e il suo valore è un numero di secondi. `<nome>`
viene inviato solo se è pubblico: un nome di dominio, un nome ENS, o un sito che il fornitore del
Web3 Score ha valutato. Un sito che ha solo un identificativo di contenuto grezzo, una chiave IPNS
o un indirizzo di rete locale o privata, senza un nome valutato, viene sommato al totale della sua
classe ed elencato come `(unlisted)`. Se un nome è pubblico si giudica dalla sua forma, senza
cercarlo: un sito Web2.5 con un nome interno sotto un dominio pubblico, come
`intranet.example.com`, verrebbe nominato. I normali siti Web2 non vengono mai annotati, nemmeno sul
tuo computer: esistono solo dentro il totale `classes.web2`.

Che cosa resta fuori, detto chiaramente. Nessun indirizzo di pagina, nessun percorso, nessun testo
cercato, nessun titolo di pagina, nessun segnalibro, nessuna password, nessun nome di file,
nessun elenco dell'ordine o degli orari delle tue visite, nessun identificativo pubblicitario. Il
rapporto sui siti nomina siti Web3 e Web2.5 pubblici e i secondi trascorsi su ciascuno in un
mese: è la cosa più vicina a un'informazione di navigazione che inviamo. Viene inviato con il tuo ID
di installazione: i siti in cui passi il tempo sono quindi collegati a quell'ID per il mese e per
il mese dopo, e poi restano solo come totali per sito senza ID, come dice la sezione seguente.

Inviato quando attivi la telemetria, quando apri e quando chiudi il browser, circa una volta al
giorno nel frattempo, e una volta in più all'inizio del mese per chiudere i totali del mese precedente. Non si invia nulla da una versione di sviluppo, da una
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
il browser non peggiora in nulla. Se hai risposto di no, nulla te lo richiede per sei mesi. Se
hai acconsentito e questa informativa cambia poi ciò che viene inviato, con la nuova versione non
si invia nulla finché non rispondi di nuovo: al successivo avvio di Orivon lo stesso blocco te lo
chiede, con una riga che dice che cosa è cambiato.

**Un identificativo è un dato personale?** Sì, lo trattiamo come tale. Da esso non possiamo sapere
chi sei, ma con esso possiamo ritrovare le tue righe: per questo è protetto come un dato personale
e per questo puoi chiederci di cancellarle.

## Che cosa conserviamo, e per quanto tempo

- **Righe d'uso**, una per computer, profilo e mese: 12 mesi, poi restano solo totali che non si
  possono ricondurre a un computer (il numero di utenti attivi, la ripartizione per paese e per
  classe).
- **Rapporti sui siti**: un elenco di siti con i secondi, con il tuo ID di installazione,
  conservato per il mese; un mese dopo la chiusura del mese viene ridotto a totali per sito per
  tutti gli utenti insieme, e i singoli rapporti vengono cancellati. Fino ad allora ogni riga
  porta il tuo ID di installazione; dopo, nessun ID.
- **Rapporti che sembrano falsificati**: i secondi sui siti che un rapporto d'uso non giustifica
  non vengono contati. Un ID di installazione che invia rapporti falsificati viene cancellato e
  rifiutato per 12 mesi, poi tolto dall'elenco. La base è il nostro legittimo interesse a
  statistiche accurate, articolo 6(1)(f).
- **Il tuo indirizzo IP e lo User-Agent**: non vengono scritti su disco. Il front end web che
  chiude la connessione cifrata non tiene alcun registro degli accessi. L'indirizzo resta solo in
  memoria, per limitare ogni indirizzo a 30 richieste in 10 minuti, e si perde al riavvio.
- **Momento di ricezione**: con una riga si conserva solo il giorno UTC, non l'ora.

## Chi lo riceve, e dove va

Solo noi. Non c'è un responsabile del trattamento né una società di analisi. Il server è nostro,
su `telemetry.orivonstack.com`, su un server virtuale preso in affitto da OVH SAS a Strasburgo,
in Francia. Le righe stanno in un database su quel server. I dati di telemetria non escono mai dall'UE (una segnalazione di problemi che invii può uscirne:
vedi [Le segnalazioni di problemi che invii](#le-segnalazioni-di-problemi-che-invii)). Se cambia,
cambia prima questa informativa e il numero di versione in alto aumenta: il consenso dato prima
smette di valere finché non la riattivi nelle Impostazioni. Il codice sorgente del server non è pubblicato;
questa informativa è la descrizione di ciò che conserva e per quanto tempo.

## I tuoi diritti

- **Vedere che cosa viene inviato.** Impostazioni > Privacy mostra entrambi i messaggi e un
  elenco di ciò che è stato inviato.
- **Accesso** alle righe che conserviamo: scrivi a privacy@orivonstack.com indicando l'ID di installazione
  mostrato nelle Impostazioni.
- **Cancellazione.** Premi **Cancella i miei dati** nelle Impostazioni: chiede al server di
  cancellare ogni riga d'uso e ogni rapporto sui siti per il tuo ID di installazione, spegne la
  telemetria e dice se è riuscito. Puoi anche scrivere a privacy@orivonstack.com indicando il tuo
  ID. I totali per sito già riuniti per tutti gli utenti non portano alcun ID, quindi il tuo non si
  può trovare tra quelli.
- **Revocare il consenso** in qualsiasi momento nelle Impostazioni.
- **Opposizione, rettifica, limitazione, portabilità.** Scrivi a privacy@orivonstack.com; i dati sono solo
  contatori, quindi rettifica e portabilità hanno poco su cui agire, ma risponderemo.
- **Reclamo** a un'autorità per la protezione dei dati. In Italia è il Garante per la protezione
  dei dati personali, `garanteprivacy.it`; puoi scegliere l'autorità del paese in cui vivi o
  lavori.

## Le segnalazioni di problemi che invii

Una segnalazione di problemi è separata dalla telemetria. Parte solo quando ne scrivi una e premi
**Invia**, con la telemetria accesa o spenta, e premere Invia una volta invia quella segnalazione e
nient'altro dopo. Apri il modulo con **Segnala un problema** nel menu, con il pulsante **Segnala**
su una scheda che si è bloccata, o dalla barra che Orivon mostra dopo essersi chiuso in modo
inatteso. Il modulo mostra il testo letterale della segnalazione prima che tu la invii, e una
casella per ogni parte che puoi lasciare fuori.

| Campo | Che cos'è |
|---|---|
| `schema` | La versione della struttura del messaggio, un numero |
| `reportId` | Un identificativo casuale creato quando premi Invia, e mostrato dopo perché tu possa citare la segnalazione. Non è collegato all'ID di installazione della telemetria né ad altro sul tuo computer |
| `description` | Ciò che hai scritto sul problema |
| `contact` | Come raggiungerti, se l'hai scritto: un indirizzo email, o un nome su GitHub o Matrix. Vuoto se non l'hai scritto |
| `version` | La versione di Orivon Browser |
| `crash.kind` | Quando la segnalazione riguarda un problema registrato da Orivon: se Orivon stesso ha incontrato un errore, se una pagina o un'altra parte di Orivon si è fermata, o se Orivon si è chiuso in modo inatteso. L'intera parte `crash` è vuota quando non scegli un problema registrato |
| `crash.at` | Quando è successo, al secondo, in UTC |
| `crash.process` | Quale parte si è fermata, ad esempio `main`, `tab` o `GPU` |
| `crash.reason` | Il motivo indicato dal sistema, ad esempio `crashed` o `oom` (memoria esaurita) |
| `crash.exitCode` | Il codice di uscita del processo che si è fermato, un numero |
| `crash.message` | Il messaggio d'errore, se c'era |
| `crash.stack` | In quale punto del codice di Orivon è avvenuto l'errore (lo stack delle chiamate) |
| `diagnostics` | Dettagli tecnici, inviati quando **Dettagli tecnici** è spuntato, come è all'apertura del modulo. Che cosa contiene è elencato sotto |
| `log` | Le ultime righe che Orivon ha scritto nel proprio registro, al massimo 1.000, inviate quando **Registro recente** è spuntato, come è all'apertura del modulo. Una riga può nominare una pagina o un file su cui Orivon stava lavorando |
| `page` | L'indirizzo della pagina che si è bloccata, inviato solo se spunti **L'indirizzo della pagina bloccata**. Mai offerto per una finestra privata |
| `dump.base64` | Il dump del crash, inviato solo se spunti **Il dump del crash**: un'istantanea della memoria del processo che si è bloccato, al massimo 5 MB. Può contenere frammenti delle pagine aperte, compreso ciò che vi avevi scritto. A differenza del resto, il modulo non può mostrarne il contenuto |
| `dump.bytes` | La dimensione del dump del crash |

Che cosa contiene `diagnostics`: la build di Orivon (la sua revisione del codice sorgente e come è
stato installato), le versioni di Electron, Chromium, Node.js e V8, e da quanto tempo Orivon era in
esecuzione; il sistema operativo e la sua versione, il tipo e il numero di processori, la memoria
installata e libera, la lingua, e la sessione del desktop (X11 o Wayland, e il nome del desktop); i
numeri del produttore e del modello della scheda grafica, la versione del suo driver, e quali
funzioni grafiche sono attive; le dimensioni e la scala di ogni schermo; quanta memoria usa ogni
tipo di processo di Orivon; quante finestre e schede sono aperte, e se la finestra è privata; le
estensioni installate (nome, identificativo, versione, attiva o no); i valori di alcune
impostazioni che cambiano il comportamento di Orivon (tema, cookie, Global Privacy Control, Do Not
Track, solo HTTPS, la modalità del DNS sicuro, risparmio di memoria ed energia, modalità di avvio,
controllo ortografico, strumenti per sviluppatori, modalità sviluppatore delle estensioni, controllo
degli aggiornamenti), mai un indirizzo o una cartella; e gli ultimi dieci problemi registrati da
Orivon (tipo, ora, processo, motivo, codice di uscita), senza i loro messaggi o indirizzi. In ogni
parte di una segnalazione, il percorso della tua cartella home è sostituito da `~`.

**Perché, e con quale base giuridica.** Per trovare e correggere il problema che segnali. Il tuo
consenso, articolo 6(1)(a) del GDPR: scrivi la segnalazione, vedi che cosa contiene, e premi Invia;
senza questo non parte nulla.

**Chi la legge.** I manutentori. Per trovarne la causa, possono dare una segnalazione a un
assistente di programmazione basato su IA, oggi Claude, prodotto da Anthropic PBC negli Stati
Uniti, che la tratta per nostro conto. È un trasferimento fuori dall'UE; il modulo lo dice accanto al
pulsante Invia, e premere Invia è il tuo consenso esplicito (articolo 49(1)(a) del GDPR). Il rischio
è quello di ogni trasferimento negli Stati Uniti: le loro autorità possono avere accesso ai dati
che vi sono conservati, con regole diverse da quelle dell'UE. Nessun altro riceve una segnalazione.

**Che cosa conserviamo, e per quanto tempo.** La segnalazione così come è stata inviata, sullo
stesso server della telemetria, per 90 giorni dal giorno in cui arriva, poi cancellata con il suo
dump. Con essa si conserva solo il giorno UTC. Il tuo indirizzo IP non viene scritto su disco; è
tenuto solo in memoria, per limitare ogni indirizzo a 6 segnalazioni l'ora. Della risposta del
server il browser legge solo se la segnalazione è arrivata.

**I tuoi diritti.** Il modulo elenca le segnalazioni che hai inviato, ciascuna con **Cancella dal
server**, che la cancella subito insieme al suo dump. Puoi anche scrivere a privacy@orivonstack.com
indicando l'ID della segnalazione, per l'accesso, la cancellazione o altro; i diritti e la via del
reclamo in [I tuoi diritti](#i-tuoi-diritti) valgono anche per le segnalazioni.

**Che cosa resta sul tuo computer.** Perché una segnalazione possa dire che cosa è andato storto,
Orivon conserva, nella cartella del proprio profilo: il suo registro di questa esecuzione e della
precedente, una traccia degli ultimi 30 problemi (degli ultimi 30 giorni), e fino a 10 dump degli
ultimi 30 giorni. Nulla di questo esce se non invii una segnalazione che lo include. Le tracce di
una finestra privata se ne vanno quando si chiude.

## Tutto il resto che il browser invia da solo

La telemetria, e le segnalazioni di problemi che scegli di inviare, sono le sole cose che arrivano
a un nostro server. Il browser fa anche richieste proprie
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

Quando un messaggio della telemetria cambia o ne viene aggiunto uno, il numero di versione in alto
aumenta. Un consenso dato con una versione precedente smette di valere: non si invia nulla finché
non riattivi la telemetria nelle Impostazioni. Una segnalazione di problemi non dipende da quel
consenso: lo dai per ogni segnalazione, con la segnalazione intera davanti, quindi un cambiamento
in ciò che contiene è scritto qui e mostrato nel modulo, senza che la versione aumenti.
