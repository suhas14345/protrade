import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";

const firebaseConfig = {
  projectId: "suhas-ag",
  appId: "1:388042104541:web:c5d19f510c25d834b64534",
  storageBucket: "suhas-ag.firebasestorage.app",
  apiKey: "AIzaSyBDYlh0gY1ehN03gFIclBZF2UoEGZ23vXM",
  authDomain: "suhas-ag.firebaseapp.com",
  messagingSenderId: "388042104541",
  measurementId: "G-R76MBSCYX3",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Connect to Firestore Emulator
if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

export { db };
