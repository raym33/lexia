// Lexia — quality gate de recuperación jurídica.
// Mide si Lexia devuelve el artículo CANÓNICO correcto para un conjunto de
// consultas con respuesta conocida. Reporta Hit@1, Hit@3, Hit@8 y MRR.
//
// Uso:  node eval/busquedas.mjs
//   Variables: BASE (def. http://localhost:5174), EVAL_EMAIL, EVAL_PASS, K (def. 8)
//
// Requiere una cuenta válida (la app está protegida por sesión). Crea una con:
//   curl -X POST $BASE/api/register -H 'content-type: application/json' \
//     -d '{"email":"eval@lexia.local","password":"evaluacion123","despacho":"Eval"}'

const BASE = process.env.BASE || 'http://localhost:5174';
const EMAIL = process.env.EVAL_EMAIL || 'eval@lexia.local';
const PASS = process.env.EVAL_PASS || 'evaluacion123';
const K = Number(process.env.K || 8);

// Consultas con su(s) artículo(s) canónico(s). Cita tal como la formatea Lexia.
const TESTS = [
  ['¿Cómo se calcula la indemnización por despido improcedente?', ['Art. 56 ET']],
  ['¿Qué plazo hay para impugnar judicialmente un despido?', ['Art. 59 ET', 'Art. 103 LRJS']],
  ['Obligación de reparar el daño causado por culpa o negligencia', ['Art. 1902 CC']],
  ['Resolver un contrato por incumplimiento de la otra parte', ['Art. 1124 CC']],
  ['Libertad de pactos y autonomía de la voluntad en los contratos', ['Art. 1255 CC']],
  ['Duración mínima del arrendamiento de vivienda habitual', ['Art. 9 LAU']],
  ['¿A quién corresponde la carga de la prueba en el proceso civil?', ['Art. 217 LEC']],
  ['¿Qué pena tiene el delito de homicidio?', ['Art. 138 CP']],
  ['¿Cuándo un homicidio se considera asesinato?', ['Art. 139 CP']],
  ['Delito de hurto de cosa mueble ajena', ['Art. 234 CP']],
  ['Ocupación o usurpación de un inmueble ajeno', ['Art. 245 CP']],
  ['Entrar en morada ajena sin consentimiento, allanamiento', ['Art. 202 CP']],
  ['Igualdad ante la ley y prohibición de discriminación', ['Art. 14 CE']],
  ['Derecho a la tutela judicial efectiva sin indefensión', ['Art. 24 CE']],
  ['Derecho a la intimidad personal y familiar', ['Art. 18 CE']],
  ['Plazo de prescripción de las acciones personales', ['Art. 1964 CC']],
  ['¿A qué edad se alcanza la mayoría de edad?', ['Art. 315 CC', 'Art. 12 CE']],
  ['¿Qué es la legítima de los herederos forzosos?', ['Art. 806 CC']],
  ['Requisitos y procedimiento para el divorcio', ['Art. 86 CC', 'Art. 81 CC']],
  ['¿En qué consiste la patria potestad sobre los hijos?', ['Art. 154 CC']],
  ['Causas de despido disciplinario del trabajador', ['Art. 54 ET']],
  ['Duración máxima del periodo de prueba', ['Art. 14 ET']],
  ['Jornada máxima de trabajo semanal', ['Art. 34 ET']],
  ['Derecho de desistimiento en compras a distancia', ['Art. 102 RDLeg 1/2007', 'Art. 104 RDLeg 1/2007']],
  ['Videovigilancia de los trabajadores y protección de datos', ['Art. 89 LO 3/2018']],
  ['Derecho a la presunción de inocencia', ['Art. 24 CE']],
  ['Libertad de expresión e información', ['Art. 20 CE']],
  ['Derecho a la educación', ['Art. 27 CE']],
  ['Derecho a la huelga de los trabajadores', ['Art. 28 CE']],
  ['Inviolabilidad del domicilio', ['Art. 18 CE']],
  ['Definición del delito de robo', ['Art. 237 CP']],
  ['Delito de estafa', ['Art. 248 CP']],
  ['Delito de apropiación indebida', ['Art. 253 CP']],
  ['Delito de lesiones', ['Art. 147 CP']],
  ['Conducir bajo la influencia de alcohol o drogas', ['Art. 379 CP']],
  ['Plazos de prescripción de los delitos', ['Art. 131 CP']],
  ['La legítima defensa como eximente', ['Art. 20 CP']],
  ['La tentativa de delito', ['Art. 16 CP']],
  ['Definición del contrato de compraventa', ['Art. 1445 CC']],
  ['Saneamiento por vicios ocultos en la compraventa', ['Art. 1484 CC']],
  ['Qué es una donación', ['Art. 618 CC']],
  ['Definición de usufructo', ['Art. 467 CC']],
  ['Qué es una servidumbre', ['Art. 530 CC']],
  ['Testamento ológrafo', ['Art. 688 CC']],
  ['Aceptar la herencia a beneficio de inventario', ['Art. 1010 CC', 'Art. 1011 CC']],
  ['Causas de nulidad del matrimonio', ['Art. 73 CC']],
  ['Sociedad de gananciales', ['Art. 1344 CC']],
  ['Quién fija el salario mínimo interprofesional', ['Art. 27 ET']],
  ['Derecho a vacaciones anuales retribuidas', ['Art. 38 ET']],
  ['Duración del contrato de trabajo y contrato indefinido', ['Art. 15 ET']],
];

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

async function main() {
  // login -> cookie
  const lr = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!lr.ok) { console.error(`Login falló (${lr.status}). Crea la cuenta ${EMAIL} o ajusta EVAL_EMAIL/EVAL_PASS.`); process.exit(1); }
  const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];

  const ranks = [];
  console.log(`${'#'.padStart(2)} rank  consulta`);
  for (let i = 0; i < TESTS.length; i++) {
    const [q, exp] = TESTS[i];
    const r = await fetch(`${BASE}/api/buscar`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ query: q, k: K }),
    });
    const { fuentes = [] } = await r.json();
    const citas = fuentes.map((f) => f.cita);
    const expn = exp.map(norm);
    const rank = (citas.findIndex((c) => expn.includes(norm(c))) + 1) || null;
    ranks.push(rank);
    console.log(`${String(i + 1).padStart(2)} ${String(rank || '-').padStart(4)}  ${rank ? 'OK ' : 'MISS'} ${q.slice(0, 50)}  ->  ${citas.slice(0, 3).join(', ')}`);
  }
  const N = ranks.length;
  const h = (p) => ranks.filter((r) => r && r <= p).length;
  const mrr = ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / N;
  console.log('-'.repeat(60));
  console.log(`Hit@1=${ranks.filter((r) => r === 1).length}/${N}  Hit@3=${h(3)}/${N}  Hit@8=${h(8)}/${N}  MRR=${mrr.toFixed(3)}`);
}
main();
