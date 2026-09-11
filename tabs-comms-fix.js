const fs = require('fs');
let code = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

const regex = /const \[searchTerm, setSearchTerm\] = useState\(''\);/;
const replacement = `const searchParams = new URLSearchParams(window.location.search);
  const filterCaseId = searchParams.get('caseId');
  const [searchTerm, setSearchTerm] = useState(filterCaseId ? \`case:\${filterCaseId}\` : '');`;
code = code.replace(regex, replacement);

const filterRegex = /const text = \(item.title \|\| item.summary \|\| item.detail \|\| item.deliveryLabel \|\| ''\).toLowerCase\(\);\n    return text.includes\(searchTerm.toLowerCase\(\)\);/;
const filterReplacement = `const term = searchTerm.toLowerCase();
    if (term.startsWith('case:')) {
      const id = term.split(':')[1].trim();
      if (id && item.caseId.toString() !== id) return false;
      return true;
    }
    const text = (item.title || item.summary || (item as any).detail || (item as any).deliveryLabel || (item as any).recipient || '').toLowerCase();
    return text.includes(term) || item.caseId.toString() === term;`;
code = code.replace(filterRegex, filterReplacement);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', code);
