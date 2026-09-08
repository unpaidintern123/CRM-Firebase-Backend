import admin from "firebase-admin";

let app;

export function getFirebaseApp() {
  if (app) return app;

  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

    if (projectId && clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    } else {
      admin.initializeApp({ projectId: projectId || "ahl-crm-database" });
    }
  }

  app = admin.app();
  return app;
}

export function getFirestore() {
  return getFirebaseApp().firestore();
}
