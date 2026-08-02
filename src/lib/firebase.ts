import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyBttCLG-igllk6fS110-J6HNo6GZdGqKT0",
  authDomain: "status-lider.firebaseapp.com",
  databaseURL: "https://status-lider-default-rtdb.firebaseio.com",
  projectId: "status-lider",
  storageBucket: "status-lider.firebasestorage.app",
  messagingSenderId: "518860276374",
  appId: "1:518860276374:web:506fb02589f40282c1f8b7",
  measurementId: "G-ZQF6WZSW3V"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app, "https://status-lider-default-rtdb.firebaseio.com");
export const auth = getAuth(app);
