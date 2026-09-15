import { pool } from "../src/db.js";

const brands = [
  ["bioderma","Bioderma","France","Dermocosmetics",1],["mustela","Mustela","France","Baby & Maternity",1],
  ["uriage","Uriage Eau Thermale","France","Thermal Skincare",1],["svr","SVR Laboratoire","France","Dermocosmetics",1],
  ["la-roche-posay","La Roche-Posay","France","Dermatology",1],["eucerin","Eucerin","Germany","Medical Skincare",1],
  ["topicrem","Topicrem","France","Dermocosmetics",2],["puressentiel","Puressentiel","France","Aromatherapy / OTC",2],
  ["chateau-rouge","Château Rouge","France","Afro-Conscious Beauty",2],["mkl-green-nature","MKL Green Nature","France","Natural Skincare",2],
  ["neutrogena","Neutrogena","USA / France","Clinical Skincare",2],["cerave","CeraVe","USA","Dermatologist Skincare",2],
  ["cetaphil","Cetaphil","USA","Gentle Skincare",2],["zwitsal","Zwitsal","Netherlands","Baby Care",2],
  ["the-ordinary","The Ordinary","Canada","Ingredient Skincare",2],["garnier","Garnier","France","Mass Premium",3],
  ["horizane-sante","Horizane Santé","France","Health & Nutraceuticals",3],["evoluderm","Evoluderm","France","Natural Body Care",3],
  ["byphasse","Byphasse","France","Accessible Skincare",3],
] as const;

async function seed() {
  for (const brand of brands) await pool.query(`INSERT INTO brands(slug,name,origin,category,priority_tier) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(slug) DO UPDATE SET name=excluded.name,origin=excluded.origin,category=excluded.category,priority_tier=excluded.priority_tier`, [...brand]);
  console.log(`Seeded ${brands.length} brands`);
}

seed().finally(() => pool.end());
