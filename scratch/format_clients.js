const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
const outputFile = process.argv[3];

const rawData = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
const clients = rawData.data;

const formattedClients = clients.map(c => {
  // Clean phone: take first number, remove non-digits
  let phone = c.telefono || '';
  phone = phone.split(/[\/-]/)[0].replace(/\D/g, '');
  
  // Add 549 if it starts with 387 (Salta) and is 10 digits
  if (phone.length === 10 && (phone.startsWith('387') || phone.startsWith('388') || phone.startsWith('381'))) {
    phone = '549' + phone;
  } else if (phone.length === 7) {
    // Local number, add 549387
    phone = '549387' + phone;
  }

  return {
    phone: phone,
    name: (c.nombre || '').trim(),
    company: (c.locali || '').trim(),
    systems: [],
    knowledgeDocs: [],
    trelloLists: {
      bugs: "",
      pendientes: ""
    },
    notes: `numcli: ${c.numcli}`
  };
}).filter(c => c.phone.length >= 10);

fs.writeFileSync(outputFile, JSON.stringify(formattedClients, null, 2), 'utf-8');
console.log(`Exported ${formattedClients.length} clients to ${outputFile}`);
