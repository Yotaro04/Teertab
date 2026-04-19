/**
 * ブラウザ用: firebase-config.js の単一初期化 + Firestore/Storage モジュラー API を window.__TF に公開
 */
import { db, storage, auth } from './firebase-config.js';
import {
    doc,
    collection,
    getDoc,
    getDocs,
    setDoc,
    deleteDoc,
    updateDoc,
    onSnapshot,
    runTransaction,
    serverTimestamp,
    deleteField,
    query,
    where,
    orderBy,
    limit,
    addDoc,
    writeBatch,
    increment
} from 'firebase/firestore';
import { ref, uploadString, getDownloadURL } from 'firebase/storage';
import {
    GoogleAuthProvider,
    onAuthStateChanged,
    signInWithPopup,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut
} from 'firebase/auth';

const bundleRef = doc(db, 'teertabSync', 'bundle');

window.__TF = {
    db,
    storage,
    auth,
    doc,
    collection,
    getDoc,
    getDocs,
    setDoc,
    deleteDoc,
    updateDoc,
    onSnapshot,
    runTransaction,
    serverTimestamp,
    deleteField,
    query,
    where,
    orderBy,
    limit,
    addDoc,
    writeBatch,
    increment,
    bundleRef,
    userDocRef: (uid) => doc(db, 'users', String(uid || '')),
    /** 全ユーザー共通の募集カード */
    postsColRef: () => collection(db, 'posts'),
    postDocRef: (postId) => doc(db, 'posts', String(postId || '')),
    applicationsColRef: () => collection(db, 'applications'),
    applicationDocRef: (applicationId) => doc(db, 'applications', String(applicationId || '')),
    notificationsColRef: () => collection(db, 'notifications'),
    notificationDocRef: (notificationId) => doc(db, 'notifications', String(notificationId || '')),
    chatsColRef: () => collection(db, 'chats'),
    chatDocRef: (chatId) => doc(db, 'chats', String(chatId || '')),
    chatMessagesColRef: (chatId) => collection(db, 'chats', String(chatId || ''), 'messages'),
    storageRef: ref,
    uploadString,
    getDownloadURL,
    GoogleAuthProvider,
    onAuthStateChanged,
    signInWithPopup,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
    ready: true
};
