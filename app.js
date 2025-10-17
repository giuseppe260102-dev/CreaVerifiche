import {
    db,
    auth,
    APP_ID,
    onAuthStateChanged
} from './firebase-config.js';

import {
    doc,
    getDoc,
    setDoc,
    onSnapshot,
    collection,
    query,
    where,
    addDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- Configurazione API ---
// L'API Key di Gemini NON dovrebbe mai essere esposta in un file frontend.
// In un'implementazione con Render (il tuo server proxy), questa chiave dovrebbe essere caricata
// da una variabile d'ambiente sul server e la chiamata API dovrebbe avvenire lato server.
// Per rendere il codice funzionante nell'ambiente di testing (Canvas), usiamo un placeholder
// sapendo che l'ambiente gestirà la chiave internamente.
const API_KEY = "";

// Variabili globali dell'Applicazione
let userId = null;
let currentRoute = 'login';
let verificationsData = []; // Cache per la dashboard del docente

// --- FUNZIONI UTILITY GLOBALI ---

function showModal(title, message) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-message').textContent = message;
    document.getElementById('modal').classList.add('flex');
    document.getElementById('modal').classList.remove('hidden');
}

function navigate(newRoute, params = {}) {
    currentRoute = newRoute;
    const url = new URL(window.location.href);
    url.searchParams.set('page', newRoute);
    Object.keys(params).forEach(key => url.searchParams.set(key, params[key]));
    window.history.pushState(null, '', url.toString());
    renderApp();
}

function copyToClipboard(elementId) {
    const copyText = document.getElementById(elementId);
    copyText.select();
    copyText.setSelectionRange(0, 99999);
    try {
        document.execCommand('copy');
        showModal("Copiato!", `Il link è stato copiato negli appunti: ${copyText.value}`);
    } catch (err) {
        showModal("Errore Copia", "Impossibile copiare il link automaticamente. Copia manualmente.");
    }
}

// Associa la funzione di copia alla finestra per renderla disponibile nell'HTML
window.copyToClipboard = copyToClipboard;
window.navigate = navigate; // Associa navigate al global scope

// --- GESTIONE DEI DATI FIRESTORE ---

// Percorsi per le collezioni
const getTeacherQuizCollection = (uid) => collection(db, `artifacts/${APP_ID}/users/${uid}/quizzes`);
const getPublicVerificationCollection = () => collection(db, `artifacts/${APP_ID}/public/data/verifications`);
const getPublicResultsCollection = () => collection(db, `artifacts/${APP_ID}/public/data/results`);

function setupFirestoreListeners() {
    if (!db || !userId) return;

    // 2. Ascolto per le Verifiche e Risultati (dati pubblici per la dashboard del docente)
    onSnapshot(getPublicVerificationCollection(), async (snapshot) => {
        const newVerificationsData = [];
        const verificationPromises = [];

        snapshot.docs.forEach(docSnap => {
            const verification = { id: docSnap.id, ...docSnap.data() };
            
            // Per motivi di performance, recuperiamo i risultati solo per la dashboard.
            const resultDocRef = doc(getPublicResultsCollection(), verification.id);
            verificationPromises.push(getDoc(resultDocRef).then(resultSnap => {
                verification.result = resultSnap.exists() ? resultSnap.data() : null;
                newVerificationsData.push(verification);
            }).catch(e => {
                console.error("Errore durante il fetch del risultato:", e);
                newVerificationsData.push(verification);
            }));
        });

        await Promise.all(verificationPromises);
        verificationsData = newVerificationsData.sort((a, b) => (b.creationDate?.seconds || 0) - (a.creationDate?.seconds || 0));

        if (currentRoute === 'dashboard') {
            renderDashboard();
        }
    });

    // Inizializza il routing
    const urlParams = new URLSearchParams(window.location.search);
    const page = urlParams.get('page');
    const verificationId = urlParams.get('vId');
    const routeToRender = (verificationId && !page) ? 'student-login' : (page || 'dashboard');
    navigate(routeToRender, { vId: verificationId });
}

// --- GESTIONE AUTENTICAZIONE e AVVIO APP ---

onAuthStateChanged(auth, (user) => {
    if (user) {
        userId = user.uid;
        document.getElementById('user-info').textContent = `ID Utente: ${userId}`;
        setupFirestoreListeners();
        renderApp();
    } else {
        document.getElementById('user-info').textContent = `Accesso Anonimo (ID non disponibile)`;
        // Non facciamo nulla finché l'autenticazione iniziale non è risolta
    }
});


// --- LOGICA DI GENERAZIONE QUIZ (GEMINI API) ---

async function generateQuizContent(topic, complexity) {
    const systemPrompt = `Sei un esperto creatore di verifiche di Informatica. Genera un JSON per una verifica dettagliata su "${topic}". La verifica deve essere complessa, articolata e contenere al massimo 20 domande (mix di risposta multipla, aperta e pratiche non-codice). Deve essere completabile in 1 ora. Inserisci immagini rilevanti come link a placeholder. Assegna punti per ogni domanda (Max totale 100).
    
    DEVI usare questo schema JSON. L'italiano DEVE essere l'unica lingua usata nel testo.
    
    Schema per la Rubrica: La rubrica deve convertire il punteggio totale (su 100) in un voto in decimi con un giudizio.
    Esempio: {"0-50": "Insufficiente (4)", "51-65": "Sufficiente (6)", "66-75": "Discreto (7)", "76-85": "Buono (8)", "86-95": "Ottimo (9)", "96-100": "Eccellente (10)"}.
    `;

    const userQuery = `Crea una verifica di ${complexity} complessità sul tema "${topic}". Includi domande teoriche, pratiche e link a immagini placeholder (es: https://placehold.co/300x200). Genera la Rubrica e l'array di domande completo.`;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${API_KEY}`;
    
    // Schema JSON strutturato per la risposta dell'AI
    const quizSchema = {
        type: "OBJECT",
        properties: {
            rubric: {
                type: "OBJECT",
                description: "La griglia di valutazione che converte il punteggio totale (0-100) in voto e giudizio."
            },
            questions: {
                type: "ARRAY",
                description: "L'array di domande (max 20)",
                items: {
                    type: "OBJECT",
                    properties: {
                        id: { type: "NUMBER" },
                        text: { type: "STRING", description: "Il testo della domanda." },
                        type: { type: "STRING", enum: ["multiple-choice", "open", "closed", "practical"], description: "Il tipo di domanda." },
                        points: { type: "NUMBER", description: "Punteggio massimo per questa domanda." },
                        correctAnswer: { type: "STRING", description: "La risposta corretta per MC/Closed, o un suggerimento per la correzione per Open/Practical." },
                        options: { type: "ARRAY", items: { type: "STRING" }, description: "Opzioni per MC (vuoto altrimenti)." },
                        image: { type: "STRING", description: "Link a placeholder immagine se necessario (es: https://placehold.co/300x200)." }
                    },
                    required: ["id", "text", "type", "points", "correctAnswer"]
                }
            }
        },
        required: ["rubric", "questions"]
    };

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: quizSchema
        }
    };

    // Implementazione del backoff esponenziale (omessa per brevità ma necessaria in produzione)
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
    }

    const result = await response.json();
    const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!jsonText) {
         throw new Error("Risposta API non valida o vuota.");
    }

    const cleanJsonText = jsonText.replace(/```json|```/g, '').trim();

    return JSON.parse(cleanJsonText);
}

// --- LOGICA DI CREAZIONE QUIZ E SALVATAGGIO SU DB ---

async function createVerifications(topic, numStudents, classes, complexity) {
    const container = document.getElementById('quiz-generator');
    const loadingBar = container.querySelector('.loading-bar');
    const studentInputs = container.querySelectorAll('.student-input');

    // 1. Generazione del Contenuto Base del Quiz
    loadingBar.style.width = '10%';
    container.querySelector('#status-message').textContent = "Generazione del contenuto base della verifica tramite AI...";
    let quizContent;
    try {
        quizContent = await generateQuizContent(topic, complexity);
    } catch (error) {
        console.error("Errore generazione Quiz:", error);
        showModal("Errore Generazione AI", `Impossibile generare il contenuto del quiz. Dettagli: ${error.message}. Riprova.`);
        loadingBar.style.width = '0%';
        return;
    }

    // 2. Creazione del Record Base nel DB (Quiz Generale) - Opzionale ma utile
    loadingBar.style.width = '30%';
    container.querySelector('#status-message').textContent = "Contenuto generato. Salvataggio configurazione quiz...";
    const quizRef = await addDoc(getTeacherQuizCollection(userId), {
        topic,
        totalStudents: numStudents,
        classes,
        complexity,
        creationDate: serverTimestamp(),
    });

    // 3. Creazione delle Verifiche Personalizzate per ogni Alunno
    const baseQuestions = quizContent.questions;
    const rubric = quizContent.rubric;
    const verificationLinks = [];

    for (let i = 0; i < numStudents; i++) {
        loadingBar.style.width = `${30 + (i / numStudents) * 60}%`;
        const studentName = studentInputs[i] ? studentInputs[i].value : `Alunno ${i + 1}`;
        const studentClass = classes[i % classes.length]; // Distribuisce ciclicamente tra le classi
        const password = Math.random().toString(36).substring(2, 8).toUpperCase(); // Token di 6 caratteri

        // Shuffle delle domande per differenziare la verifica
        const personalizedQuestions = [...baseQuestions].sort(() => Math.random() - 0.5);

        const verificationDoc = {
            quizId: quizRef.id,
            studentName: studentName,
            class: studentClass,
            date: new Date().toLocaleDateString('it-IT'),
            uniqueCode: `VERIFICA-${quizRef.id.substring(0, 4)}-${i + 1}`,
            password: password,
            status: 'pending',
            questions: personalizedQuestions,
            rubric: rubric,
            creationDate: serverTimestamp(),
        };

        const verifRef = await addDoc(getPublicVerificationCollection(), verificationDoc);
        const verificationId = verifRef.id;

        const verificationLink = `${window.location.origin}${window.location.pathname}?vId=${verificationId}`;

        verificationLinks.push({
            name: studentName,
            class: studentClass,
            link: verificationLink,
            password: password,
            verificationId: verificationId
        });

        container.querySelector('#status-message').textContent = `Creazione verifica per ${studentName} (${studentClass})...`;
    }

    loadingBar.style.width = '100%';
    container.querySelector('#status-message').textContent = "Tutte le verifiche sono state create e salvate!";
    setTimeout(() => {
        navigate('dashboard', { links: JSON.stringify(verificationLinks) });
    }, 1000);
}

// Associa la funzione al global scope per essere chiamata dall'HTML
window.createVerifications = createVerifications;


// --- LOGICA DI CORREZIONE E GRADING ---
function correctVerification(questions, studentAnswers, rubric) {
    let totalScore = 0;
    let maxScore = 0;
    const correctedAnswers = [];

    questions.forEach(q => {
        maxScore += q.points;
        const studentAnswer = studentAnswers[q.id] || '';
        let score = 0;
        let comment = '';
        let isCorrect = false;

        if (q.type === 'multiple-choice' || q.type === 'closed') {
            if (studentAnswer.toString().toUpperCase().trim() === q.correctAnswer.toString().toUpperCase().trim()) {
                score = q.points;
                comment = 'Risposta esatta.';
                isCorrect = true;
            } else {
                comment = `Risposta errata. Quella corretta era: ${q.correctAnswer}`;
            }
        } else if (q.type === 'open' || q.type === 'practical') {
            // Placeholder: Assumiamo parziale se la risposta è sostanziosa
            if (studentAnswer.length > 15) {
                score = Math.floor(q.points / 2);
                comment = `Valutazione preliminare automatica: ${score}/${q.points} punti. La correzione finale spetta al docente.`;
                isCorrect = true; 
            } else {
                comment = 'Risposta insufficiente o mancante. Correggere manualmente.';
            }
        }

        totalScore += score;
        correctedAnswers.push({
            questionId: q.id,
            answer: studentAnswer,
            isCorrect: isCorrect,
            score: score,
            maxPoints: q.points,
            comment: comment
        });
    });

    // Conversione del punteggio in voto (base 10)
    const percentage = (totalScore / maxScore) * 100;
    let finalGrade = 'Non classificato';

    for (const range in rubric) {
        const [min, max] = range.split('-').map(Number);
        if (percentage >= min && percentage <= max) {
            finalGrade = rubric[range];
            break;
        }
    }

    return { totalScore, maxScore, percentage, finalGrade, correctedAnswers };
}

// --- LOGICA DI SOTTOMISSIONE E CORREZIONE ---
async function submitQuiz(verificationId, verificationDoc) {
    const form = document.getElementById('quiz-form');
    const formData = new FormData(form);
    const studentAnswers = {};
    for (const [key, value] of formData.entries()) {
        const qId = parseInt(key.replace('q-', ''));
        studentAnswers[qId] = value;
    }

    showModal("Consegna in Corso", "Stiamo correggendo la verifica e calcolando il voto...");
    const results = correctVerification(verificationDoc.questions, studentAnswers, verificationDoc.rubric);

    await setDoc(doc(getPublicVerificationCollection(), verificationId), {
        ...verificationDoc,
        status: 'submitted',
    }, { merge: true }); // Usiamo merge per non sovrascrivere l'intero documento

    const resultDoc = {
        verificationId: verificationId,
        submissionDate: serverTimestamp(),
        studentName: verificationDoc.studentName,
        class: verificationDoc.class,
        totalScore: results.totalScore,
        maxScore: results.maxScore,
        finalGrade: results.finalGrade,
        studentAnswers: results.correctedAnswers,
        rubric: verificationDoc.rubric,
        uniqueCode: verificationDoc.uniqueCode,
    };

    await setDoc(doc(getPublicResultsCollection(), verificationId), resultDoc);

    showModal("Verifica Consegnata", `La tua verifica è stata consegnata e corretta. Hai ottenuto un punteggio di ${results.totalScore}/${results.maxScore} (${results.finalGrade}). Clicca per vedere il report completo.`);

    setTimeout(() => {
        navigate('results', { vId: verificationId });
    }, 1000);
}
window.submitQuiz = submitQuiz; // Funzione esposta

// --- RENDERING DELLE VISTE ---

function renderDashboard(links = null) {
    const appContainer = document.getElementById('app-container');
    const currentLinks = links ? JSON.parse(links) : null;
    let tableRows = '';

    if (verificationsData.length === 0) {
        tableRows = `
            <tr>
                <td colspan="5" class="py-4 text-center text-gray-500">
                    Nessuna verifica creata. Clicca "Crea Nuova Verifica" per iniziare.
                </td>
            </tr>
        `;
    } else {
        tableRows = verificationsData.map(v => {
            const grade = v.result ? v.result.finalGrade : 'N/D';
            const statusColor = v.status === 'submitted' ? 'text-green-600 font-semibold' : 'text-yellow-600';
            const date = v.creationDate ? new Date(v.creationDate.seconds * 1000).toLocaleDateString('it-IT') : 'Data sconosciuta';
            
            return `
                <tr class="border-b hover:bg-gray-50 transition duration-150">
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${v.class || 'N/D'}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${v.studentName || 'N/D'}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${v.topic || 'N/D'}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm ${statusColor}">${v.status === 'submitted' ? 'Consegnata' : 'In attesa'}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-bold text-indigo-700">${v.status === 'submitted' ? grade : 'N/A'}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${date}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button onclick="navigate('results', { vId: '${v.id}' })" class="text-indigo-600 hover:text-indigo-900 disabled:opacity-50" ${v.status !== 'submitted' ? 'disabled' : ''}>
                            ${v.status === 'submitted' ? 'Vedi Report' : 'Attendi Consegna'}
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    let linksHtml = '';
    if (currentLinks && currentLinks.length > 0) {
        linksHtml = `
            <div class="card p-6 mb-8 bg-green-50 border border-green-200">
                <h3 class="text-lg font-bold text-green-800 mb-4">Verifiche create con successo!</h3>
                <p class="text-sm text-green-700 mb-4">Condividi questi link e codici con i tuoi studenti:</p>
                <div class="space-y-3 max-h-64 overflow-y-auto pr-2">
                    ${currentLinks.map(l => `
                        <div class="flex items-center space-x-3 p-2 bg-white rounded-lg shadow-sm">
                            <span class="font-medium text-gray-700">${l.class} - ${l.name}:</span>
                            <span class="text-sm font-mono bg-gray-100 p-1 rounded">Codice: ${l.password}</span>
                            <input type="text" id="link-${l.verificationId}" value="${l.link}" class="flex-grow text-xs border-0 focus:ring-0">
                            <button onclick="copyToClipboard('link-${l.verificationId}')" class="text-indigo-500 hover:text-indigo-700 p-1 rounded-full bg-indigo-50 hover:bg-indigo-100 transition duration-150">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7v8a2 2 0 002 2h6M8 7v8a2 2 0 002 2h6m-6 0v2m0-2h2m-6 0v2m0-2h2"></path></svg>
                            </button>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    appContainer.innerHTML = `
        <div class="flex justify-between items-center mb-6 no-print">
            <h2 class="text-2xl font-bold text-gray-700">Dashboard Docente</h2>
            <button onclick="navigate('generator')" class="btn-primary px-4 py-2 rounded-lg font-semibold flex items-center">
                <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                Crea Nuova Verifica
            </button>
        </div>

        ${linksHtml}

        <div class="card overflow-hidden">
            <div class="overflow-x-auto">
                <table class="min-w-full divide-y divide-gray-200">
                    <thead class="bg-gray-50">
                        <tr>
                            <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Classe</th>
                            <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Alunno</th>
                            <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Argomento</th>
                            <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Stato</th>
                            <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Voto Finale</th>
                            <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Data Creazione</th>
                            <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Azione</th>
                        </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-200">
                        ${tableRows}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function renderGenerator() {
    const appContainer = document.getElementById('app-container');
    appContainer.innerHTML = `
        <div class="card p-6 sm:p-10" id="quiz-generator">
            <h2 class="text-2xl font-bold text-gray-700 mb-6">Genera Nuove Verifiche Personalizzate</h2>
            <div id="loading-area" class="mb-6 hidden">
                <div class="relative pt-1">
                    <div class="flex mb-2 items-center justify-between">
                        <div>
                            <span class="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full text-indigo-600 bg-indigo-200">
                                <span id="status-message">Generazione in corso...</span>
                            </span>
                        </div>
                    </div>
                    <div class="overflow-hidden h-2 mb-4 text-xs flex rounded bg-indigo-200">
                        <div class="loading-bar shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-indigo-500"></div>
                    </div>
                </div>
            </div>

            <form id="generator-form">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    <div>
                        <label for="topic" class="block text-sm font-medium text-gray-700 mb-1">Argomento della Verifica (Es: 'Strutture Dati in C++' o 'Storia di Internet')</label>
                        <input type="text" id="topic" name="topic" required class="w-full border-gray-300 rounded-lg shadow-sm p-3 focus:border-indigo-500 focus:ring-indigo-500" placeholder="Inserisci l'argomento">
                    </div>
                    <div>
                        <label for="complexity" class="block text-sm font-medium text-gray-700 mb-1">Livello di Complessità</label>
                        <select id="complexity" name="complexity" required class="w-full border-gray-300 rounded-lg shadow-sm p-3 focus:border-indigo-500 focus:ring-indigo-500">
                            <option value="Base">Base (1° Anno)</option>
                            <option value="Intermedia" selected>Intermedia (2°/3° Anno)</option>
                            <option value="Avanzata">Avanzata (4°/5° Anno)</option>
                        </select>
                    </div>
                </div>

                <div class="mb-6">
                    <label class="block text-sm font-medium text-gray-700 mb-2">Classi Coinvolte (Separa con virgola, Es: 4A, 4B, 5C)</label>
                    <input type="text" id="classes" name="classes" value="4AI, 4BI" required class="w-full border-gray-300 rounded-lg shadow-sm p-3 focus:border-indigo-500 focus:ring-indigo-500">
                </div>

                <div class="mb-6">
                    <h3 class="text-lg font-bold text-gray-700 mb-3 flex justify-between items-center">
                        Lista Studenti (Verifiche Personalizzate)
                        <button type="button" id="add-student-btn" class="text-indigo-600 hover:text-indigo-800 text-sm font-medium flex items-center">
                            <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"></path></svg>
                            Aggiungi Studente
                        </button>
                    </h3>
                    <div id="students-list" class="space-y-3">
                        <input type="text" placeholder="Nome Cognome Alunno 1" class="student-input w-full border-gray-300 rounded-lg shadow-sm p-3">
                        <input type="text" placeholder="Nome Cognome Alunno 2" class="student-input w-full border-gray-300 rounded-lg shadow-sm p-3">
                        <input type="text" placeholder="Nome Cognome Alunno 3" class="student-input w-full border-gray-300 rounded-lg shadow-sm p-3">
                    </div>
                </div>

                <div class="flex justify-between items-center mt-8 pt-4 border-t border-gray-200 no-print">
                    <button type="button" onclick="navigate('dashboard')" class="text-gray-600 hover:text-gray-800 font-medium">Annulla e Torna alla Dashboard</button>
                    <button type="submit" id="generate-btn" class="btn-primary px-8 py-3 rounded-lg font-bold transition duration-150">
                        Genera 3 Verifiche
                    </button>
                </div>
            </form>
        </div>
    `;

    // Logica per aggiungere alunni
    document.getElementById('add-student-btn').onclick = () => {
        const list = document.getElementById('students-list');
        const count = list.querySelectorAll('.student-input').length + 1;
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = `Nome Cognome Alunno ${count}`;
        input.className = 'student-input w-full border-gray-300 rounded-lg shadow-sm p-3';
        list.appendChild(input);
        
        // Aggiorna il testo del pulsante di generazione
        document.getElementById('generate-btn').textContent = `Genera ${count} Verifiche`;
    };

    // Logica per l'aggiornamento dinamico del pulsante
    document.getElementById('students-list').oninput = () => {
         const numStudents = document.querySelectorAll('.student-input').length;
         document.getElementById('generate-btn').textContent = `Genera ${numStudents} Verifiche`;
    }

    // Logica di Sottomissione del Form
    document.getElementById('generator-form').onsubmit = async (e) => {
        e.preventDefault();

        const form = e.target;
        const topic = form.topic.value;
        const complexity = form.complexity.value;
        const classes = form.classes.value.split(',').map(c => c.trim()).filter(c => c.length > 0);
        
        const studentInputs = document.querySelectorAll('.student-input');
        const numStudents = studentInputs.length;
        
        if (!topic || !classes.length || numStudents === 0) {
            showModal("Errore", "Compila tutti i campi richiesti e inserisci almeno un alunno.");
            return;
        }

        document.getElementById('loading-area').classList.remove('hidden');
        document.getElementById('generate-btn').disabled = true;

        await createVerifications(topic, numStudents, classes, complexity);

        document.getElementById('loading-area').classList.add('hidden');
        document.getElementById('generate-btn').disabled = false;
    };
}

function renderStudentLogin() {
    const appContainer = document.getElementById('app-container');
    const urlParams = new URLSearchParams(window.location.search);
    const verificationId = urlParams.get('vId');

    if (!verificationId) {
        appContainer.innerHTML = `<div class="card p-6 text-center text-red-600">Errore: ID Verifica non specificato.</div>`;
        return;
    }

    appContainer.innerHTML = `
        <div class="card p-6 sm:p-10 max-w-lg mx-auto">
            <h2 class="text-2xl font-bold text-indigo-700 mb-2">Accesso alla Verifica</h2>
            <p class="text-gray-600 mb-6">Inserisci la password univoca fornita dal docente per iniziare.</p>
            <div id="login-status" class="hidden p-3 mb-4 rounded-lg text-sm font-medium"></div>
            
            <form id="student-login-form">
                <input type="hidden" name="verificationId" value="${verificationId}">
                <div class="mb-4">
                    <label for="password" class="block text-sm font-medium text-gray-700 mb-1">Codice di Accesso (Password)</label>
                    <input type="text" id="password" name="password" required class="w-full border-gray-300 rounded-lg shadow-sm p-3 focus:border-indigo-500 focus:ring-indigo-500 uppercase tracking-widest text-center text-lg" placeholder="ES: AB12CD">
                </div>
                <button type="submit" class="w-full btn-primary px-4 py-3 rounded-lg font-bold transition duration-150">
                    Avvia la Verifica
                </button>
            </form>
        </div>
    `;

    document.getElementById('student-login-form').onsubmit = async (e) => {
        e.preventDefault();
        const passwordInput = document.getElementById('password');
        const statusDiv = document.getElementById('login-status');
        const enteredPassword = passwordInput.value.toUpperCase().trim();

        passwordInput.disabled = true;
        statusDiv.classList.remove('hidden');
        statusDiv.className = 'p-3 mb-4 rounded-lg text-sm font-medium bg-indigo-100 text-indigo-800';
        statusDiv.textContent = 'Verifica codice...';

        try {
            const docRef = doc(getPublicVerificationCollection(), verificationId);
            const docSnap = await getDoc(docRef);

            if (!docSnap.exists()) {
                statusDiv.className = 'p-3 mb-4 rounded-lg text-sm font-medium bg-red-100 text-red-800';
                statusDiv.textContent = 'Errore: Verifica non trovata.';
                return;
            }

            const verificationDoc = docSnap.data();

            if (verificationDoc.password !== enteredPassword) {
                statusDiv.className = 'p-3 mb-4 rounded-lg text-sm font-medium bg-red-100 text-red-800';
                statusDiv.textContent = 'Codice di accesso errato. Riprova.';
                return;
            }
            
            if (verificationDoc.status === 'submitted') {
                 statusDiv.className = 'p-3 mb-4 rounded-lg text-sm font-medium bg-yellow-100 text-yellow-800';
                 statusDiv.textContent = 'Verifica già consegnata. Reindirizzamento al report.';
                 setTimeout(() => navigate('results', { vId: verificationId }), 1000);
                 return;
            }


            // Successo: Avvia il Quiz
            navigate('quiz', { vId: verificationId });

        } catch (error) {
            console.error("Errore di accesso:", error);
            statusDiv.className = 'p-3 mb-4 rounded-lg text-sm font-medium bg-red-100 text-red-800';
            statusDiv.textContent = 'Si è verificato un errore tecnico. Riprova.';
        } finally {
            passwordInput.disabled = false;
        }
    };
}

async function renderQuiz() {
    const appContainer = document.getElementById('app-container');
    const urlParams = new URLSearchParams(window.location.search);
    const verificationId = urlParams.get('vId');

    if (!verificationId) {
        appContainer.innerHTML = `<div class="card p-6 text-center text-red-600">Errore: ID Verifica non specificato.</div>`;
        return;
    }

    appContainer.innerHTML = `<div class="card p-6 text-center text-indigo-600 font-medium">Caricamento della verifica...</div>`;

    try {
        const docRef = doc(getPublicVerificationCollection(), verificationId);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            appContainer.innerHTML = `<div class="card p-6 text-center text-red-600">Errore: Verifica non trovata.</div>`;
            return;
        }

        const verificationDoc = docSnap.data();

        if (verificationDoc.status === 'submitted') {
            appContainer.innerHTML = `<div class="card p-6 text-center text-yellow-600">Questa verifica è già stata consegnata. <button onclick="navigate('results', { vId: '${verificationId}' })" class="text-indigo-600 hover:underline">Vedi il report qui.</button></div>`;
            return;
        }

        const questionsHtml = verificationDoc.questions.map((q, index) => {
            let inputField;
            const qId = q.id;

            if (q.type === 'multiple-choice') {
                inputField = q.options.map((option, optIndex) => `
                    <div class="flex items-center">
                        <input id="q-${qId}-opt-${optIndex}" name="q-${qId}" type="radio" value="${option}" required class="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300">
                        <label for="q-${qId}-opt-${optIndex}" class="ml-3 block text-sm font-medium text-gray-700">${option}</label>
                    </div>
                `).join('');
            } else if (q.type === 'closed') {
                 inputField = `
                    <input type="text" name="q-${qId}" required class="w-full border-gray-300 rounded-lg shadow-sm p-3 focus:border-indigo-500 focus:ring-indigo-500" placeholder="Risposta breve">
                `;
            } else if (q.type === 'open' || q.type === 'practical') {
                inputField = `
                    <textarea name="q-${qId}" rows="4" required class="w-full border-gray-300 rounded-lg shadow-sm p-3 focus:border-indigo-500 focus:ring-indigo-500" placeholder="Scrivi la tua risposta dettagliata qui..."></textarea>
                `;
            }

            const imageHtml = q.image ? `<img src="${q.image}" alt="Diagramma o Immagine di riferimento" class="my-4 rounded-lg shadow-md max-w-full h-auto mx-auto md:max-w-md">` : '';

            return `
                <div class="mb-8 p-6 bg-white border border-gray-200 rounded-xl shadow-lg">
                    <div class="flex justify-between items-start mb-4">
                        <h3 class="text-lg font-semibold text-gray-800">${index + 1}. ${q.text}</h3>
                        <span class="text-sm font-bold text-indigo-600 p-1 bg-indigo-50 rounded-lg">${q.points} Punti</span>
                    </div>
                    ${imageHtml}
                    <div class="mt-4 space-y-3">
                        ${inputField}
                    </div>
                </div>
            `;
        }).join('');

        appContainer.innerHTML = `
            <div class="card p-6 sm:p-10" id="printable-area">
                <header class="mb-8 border-b pb-4">
                    <h1 class="text-3xl font-extrabold text-gray-900">${verificationDoc.topic || 'Verifica di Informatica'}</h1>
                    <p class="text-md text-gray-600 mt-2">
                        Alunno: <span class="font-semibold">${verificationDoc.studentName}</span> | Classe: <span class="font-semibold">${verificationDoc.class}</span> | Data: ${verificationDoc.date}
                    </p>
                    <p class="text-sm text-gray-500">Codice Univoco: ${verificationDoc.uniqueCode}</p>
                </header>

                <form id="quiz-form" onsubmit="event.preventDefault(); submitQuiz('${verificationId}', ${JSON.stringify(verificationDoc).replace(/"/g, '&quot;')})">
                    ${questionsHtml}
                    
                    <div class="flex justify-center mt-10 no-print">
                        <button type="submit" class="btn-primary px-12 py-3 rounded-xl font-bold text-lg shadow-xl hover:shadow-2xl transition duration-300">
                            Consegna Verifica
                        </button>
                    </div>
                </form>
            </div>
        `;

    } catch (error) {
        console.error("Errore nel rendering del quiz:", error);
        appContainer.innerHTML = `<div class="card p-6 text-center text-red-600">Impossibile caricare la verifica. Dettagli: ${error.message}</div>`;
    }
}

async function renderResults() {
    const appContainer = document.getElementById('app-container');
    const urlParams = new URLSearchParams(window.location.search);
    const verificationId = urlParams.get('vId');

    if (!verificationId) {
        appContainer.innerHTML = `<div class="card p-6 text-center text-red-600">Errore: ID Verifica non specificato per i risultati.</div>`;
        return;
    }

    appContainer.innerHTML = `<div class="card p-6 text-center text-indigo-600 font-medium">Caricamento dei risultati...</div>`;

    try {
        const docRef = doc(getPublicResultsCollection(), verificationId);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            appContainer.innerHTML = `<div class="card p-6 text-center text-yellow-600">Risultati non ancora disponibili o verifica non consegnata.</div>`;
            return;
        }

        const resultDoc = docSnap.data();

        // Estrai il voto base (il numero tra parentesi)
        const gradeMatch = resultDoc.finalGrade.match(/\((\d+)\)/);
        const numericGrade = gradeMatch ? parseInt(gradeMatch[1]) : 'N/A';
        const gradeColor = numericGrade >= 6 ? 'text-green-700 bg-green-100' : 'text-red-700 bg-red-100';

        const correctionsHtml = resultDoc.studentAnswers.map((answer, index) => {
            const originalQuestion = resultDoc.questions.find(q => q.id === answer.questionId);
            const isFullyCorrect = answer.score === answer.maxPoints && answer.maxPoints > 0;
            const answerColor = isFullyCorrect ? 'border-green-400' : 'border-red-400';
            const icon = isFullyCorrect ? 
                '<svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>' :
                '<svg class="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
            
            return `
                <div class="mb-6 p-5 border-l-4 ${answerColor} bg-gray-50 rounded-lg shadow-sm">
                    <div class="flex justify-between items-start mb-3">
                        <h4 class="text-md font-semibold text-gray-800">Domanda ${index + 1}: ${originalQuestion.text}</h4>
                        <div class="flex items-center space-x-2">
                            ${icon}
                            <span class="text-lg font-bold text-gray-900">${answer.score}/${answer.maxPoints}</span>
                        </div>
                    </div>
                    
                    <p class="text-sm font-medium text-gray-700 mb-2">La tua risposta:</p>
                    <div class="p-3 border rounded-lg bg-white text-gray-600 whitespace-pre-wrap">${answer.answer}</div>
                    
                    <p class="text-sm font-medium mt-3 mb-1 text-indigo-700">Commento e Correzione:</p>
                    <p class="text-sm text-gray-800">${answer.comment}</p>
                </div>
            `;
        }).join('');

        const rubricHtml = Object.entries(resultDoc.rubric).map(([range, grade]) => `
            <div class="flex justify-between p-2 border-b">
                <span class="text-sm text-gray-600">${range}%</span>
                <span class="text-sm font-medium">${grade}</span>
            </div>
        `).join('');


        appContainer.innerHTML = `
            <div class="card p-6 sm:p-10" id="printable-area">
                <header class="mb-8 border-b pb-4 no-print">
                    <div class="flex justify-between items-start">
                        <h1 class="text-3xl font-extrabold text-gray-900">Report di Verifica</h1>
                        <button onclick="window.print()" class="no-print btn-primary px-4 py-2 rounded-lg font-semibold flex items-center">
                            <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2z"></path></svg>
                            Stampa / Salva PDF
                        </button>
                    </div>
                </header>
                
                <section class="mb-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div class="card p-5 bg-white shadow-xl lg:col-span-2">
                        <h2 class="text-2xl font-bold text-indigo-700 mb-4">Dettagli Studente & Verifica</h2>
                        <div class="space-y-2 text-gray-700">
                            <p><strong>Alunno:</strong> ${resultDoc.studentName}</p>
                            <p><strong>Classe:</strong> ${resultDoc.class}</p>
                            <p><strong>Argomento:</strong> ${resultDoc.topic || 'Non Specificato'}</p>
                            <p><strong>Data Consegna:</strong> ${new Date(resultDoc.submissionDate.seconds * 1000).toLocaleString('it-IT')}</p>
                            <p><strong>Codice Univoco:</strong> <span class="font-mono text-sm bg-gray-100 p-1 rounded">${resultDoc.uniqueCode}</span></p>
                        </div>
                    </div>
                    
                    <div class="card p-5 shadow-xl ${gradeColor}">
                        <h2 class="text-xl font-bold mb-2">Voto Finale</h2>
                        <p class="text-5xl font-extrabold">${numericGrade}</p>
                        <p class="text-lg font-medium mt-1">${resultDoc.finalGrade}</p>
                        <p class="text-sm mt-2">Punteggio: ${resultDoc.totalScore}/${resultDoc.maxScore}</p>
                    </div>
                </section>
                
                <section class="mb-8">
                    <h2 class="text-2xl font-bold text-gray-700 mb-4">Correzione Dettagliata</h2>
                    <div class="space-y-4">
                        ${correctionsHtml}
                    </div>
                </section>

                <section class="no-print">
                    <h2 class="text-2xl font-bold text-gray-700 mb-4">Rubrica di Conversione (0-10)</h2>
                    <div class="card p-5 bg-white shadow-lg max-w-md">
                        ${rubricHtml}
                    </div>
                </section>
                
                <footer class="mt-8 pt-4 border-t border-gray-200 flex justify-center no-print">
                    <button onclick="navigate('dashboard')" class="text-indigo-600 hover:text-indigo-800 font-medium">
                        Torna alla Dashboard Docente
                    </button>
                </footer>
            </div>
        `;

    } catch (error) {
        console.error("Errore nel rendering dei risultati:", error);
        appContainer.innerHTML = `<div class="card p-6 text-center text-red-600">Impossibile caricare i risultati. Verifica che la verifica sia stata consegnata.</div>`;
    }
}


function renderApp() {
    // Gestione del routing in base alla rotta corrente
    const urlParams = new URLSearchParams(window.location.search);
    const verificationId = urlParams.get('vId');
    const links = urlParams.get('links');
    
    // Logica di routing semplice
    if (verificationId && currentRoute !== 'dashboard' && currentRoute !== 'results' && currentRoute !== 'generator') {
        // Se c'è un vId nell'URL, l'utente è uno studente e deve vedere il login o il quiz
        if (currentRoute === 'quiz') {
            renderQuiz();
        } else if (currentRoute === 'results') {
             renderResults();
        } else {
            renderStudentLogin();
        }
    } else {
        // Altrimenti, l'utente è il docente e vede il pannello di controllo
        if (currentRoute === 'generator') {
            renderGenerator();
        } else if (currentRoute === 'dashboard') {
            renderDashboard(links);
        } else {
            // Default o login non gestito (mostriamo la dashboard del docente se autenticato)
             renderDashboard(links);
        }
    }
}

// Esponi le funzioni di rendering per l'inizializzazione
export { renderApp };
