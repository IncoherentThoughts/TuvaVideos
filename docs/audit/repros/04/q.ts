import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { readonly: true });
console.log(db.query(process.argv[3]).all());
