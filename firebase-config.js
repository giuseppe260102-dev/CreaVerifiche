import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, setLogLevel } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// Impostazioni di debug
setLogLevel('debug');

// La configurazione Firebase fornita dall'utente
const firebaseConfig = {
    apiKey: "AIzaSyAO7SqlDdt8s3YllOpr4XUAFhO7CpOJGTY",
    authDomain: "verifiche-595e5.firebaseapp.com",
    projectId: "verifiche-595e5",
    storageBucket: "verifiche-595e5.firebasestorage.app",
    messagingSenderId: "312141887267",
    appId: "1:312141887267:web:9c132b7afbe93caa0dfe96",
    measurementId: "G-9FVR61W312"
};

// Inizializza Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Simula l'ID dell'applicazione, necessario per la struttura del database.
// In un ambiente reale, potresti usare projectId o un valore fisso.
const APP_ID = firebaseConfig.projectId;

let currentUserId = null;
let isAuthReady = false;

// Funzione per l'autenticazione iniziale (anonima o con token)
async function initialAuth() {
    // Tentiamo l'autenticazione anonima come fallback per un ambiente GitHub standard
    try {
        // --- NOTE PER L'AMBIENTE CANVAS ---
        // Se si è in ambiente Canvas e __initial_auth_token è definito,
        // l'autenticazione deve usare signInWithCustomToken(auth, __initial_auth_token)
        // Per GitHub/Render, usiamo anonima.
        await signInAnonymously(auth);
    } catch (e) {
        console.error("Errore durante l'autenticazione anonima:", e);
    }
}

// Avvia l'autenticazione
initialAuth();

// Esporta le istanze e le funzioni necessarie
export { db, auth, APP_ID, onAuthStateChanged, currentUserId, isAuthReady };
