import bcrypt from "bcryptjs";
import { getFirestore } from "./firebase.js";

async function verifyPassword(user, plainPassword) {
  const input = String(plainPassword || "");
  if (!input || !user.passwordHash) return false;
  return bcrypt.compare(input, user.passwordHash);
}

export async function checkLogin(loginDetail) {
  const username = String(loginDetail.username || "").trim();
  const db = getFirestore();
  const userRef = db.collection("users").doc(username);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    return {
      message: "Username or password is incorrect",
    };
  }

  const user = userSnap.data();

  const valid = await verifyPassword(user, loginDetail.password);
  if (!valid) {
    return {
      message: "Username or password is incorrect",
    };
  }

  const defaultLink = process.env.CRM_WEB_APP_URL
    ? `${String(process.env.CRM_WEB_APP_URL).replace(/\/$/, "")}?page=Home`
    : "";

  return {
    link: user.homeLink || defaultLink,
    message: "Login Successful",
    user: {
      username: user.username || username,
      permission: user.permission || "User",
    },
  };
}
