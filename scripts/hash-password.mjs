// usage: npm run hash-password -- "my strong password"
import bcrypt from "bcryptjs";
const pw = process.argv[2];
if (!pw) {
  console.error('usage: npm run hash-password -- "your password"');
  process.exit(1);
}
console.log(bcrypt.hashSync(pw, 12));
