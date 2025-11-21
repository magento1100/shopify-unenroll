import axios from 'axios';
import inquirer from 'inquirer';

const API_BASE = "https://securitymasterclasses.securityexcellence.net/admin/api/v2";
const LW_CLIENT = "64facb2d6072346ff30ed226";
const AUTH_TOKEN = "O4EwphUJmAjwegMMAxMYGZBpeewtpxF2PXrAv8yX";

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    "Accept": "application/json",
    "Authorization": `Bearer ${AUTH_TOKEN}`,
    "Lw-Client": LW_CLIENT,
    "Content-Type": "application/json"
  }
});

// Functions
async function getUser(email) {
  const res = await api.get(`/users/${encodeURIComponent(email)}?include_suspended=true`);
  return res.data;
}

async function getAssignedCourses(email) {
  const res = await api.get(`/users/${encodeURIComponent(email)}/courses`);
  return res.data;
}

async function getUserProducts(email) {
  const res = await api.get(`/users/${encodeURIComponent(email)}/products`);
  return res.data;
}

async function unenroll(email, productId, productType) {
  const res = await api.delete(`/users/${encodeURIComponent(email)}/enrollment`, {
    data: { productId, productType }
  });
  return res.data;
}

async function enroll(email, productId, productType, price = 0, sendEmail = true) {
  const data = {
    productId,
    productType,
    justification: "Added by admin",
    price,
    send_enrollment_email: sendEmail
  };
  const res = await api.post(`/users/${encodeURIComponent(email)}/enrollment`, data);
  return res.data;
}

// Main interactive flow
async function main() {
  const { email } = await inquirer.prompt([
    { name: 'email', message: 'Enter user email:' }
  ]);

  console.log("\nFetching user details...");
  const user = await getUser(email);
  console.log(user);

  console.log("\nFetching assigned courses...");
  const courses = await getAssignedCourses(email);
  courses.forEach((c, i) => console.log(`${i + 1}. ${c.name} (ID: ${c.id})`));

  console.log("\nFetching user products...");
  const products = await getUserProducts(email);
  products.forEach((p, i) => console.log(`${i + 1}. ${p.name} (ID: ${p.id}, Type: ${p.type})`));

  // Unenroll option
  if (products.length > 0) {
    const { productToRemove } = await inquirer.prompt([
      {
        type: 'list',
        name: 'productToRemove',
        message: 'Select a product to unenroll (or press Ctrl+C to skip):',
        choices: products.map(p => ({ name: p.name, value: p }))
      }
    ]);
    const unenrollRes = await unenroll(email, productToRemove.id, productToRemove.type);
    console.log("Unenroll Response:", unenrollRes);
  }

  // Enroll option
  const { enrollProductId, enrollProductType, enrollPrice } = await inquirer.prompt([
    { name: 'enrollProductId', message: 'Enter Product ID to enroll (or leave empty to skip):' },
    { name: 'enrollProductType', message: 'Enter Product Type (bundle/course):', default: 'bundle' },
    { name: 'enrollPrice', message: 'Enter price:', default: 0 }
  ]);

  if (enrollProductId) {
    const enrollRes = await enroll(email, enrollProductId, enrollProductType, Number(enrollPrice), true);
    console.log("Enroll Response:", enrollRes);
  }

  console.log("\nDone!");
}

// Run the script
main();
