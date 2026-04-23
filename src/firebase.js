import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyA7QXWZGTaQk1Pa8yDZmLV-o4h5dMJML44",
  authDomain: "zenlfow.firebaseapp.com",
  projectId: "zenlfow",
  storageBucket: "zenlfow.firebasestorage.app",
  messagingSenderId: "41891334631",
  appId: "1:41891334631:web:dfc431a809d94e87671542",
  measurementId: "G-FXDZHFMVRK"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);
