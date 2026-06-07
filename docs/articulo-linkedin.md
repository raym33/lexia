# Cómo construir un chatbot LOCAL para consultar leyes ⚖️

Buscar legislación parece sencillo hasta que intentas responder una pregunta jurídica concreta: localizar la norma aplicable, comprobar su vigencia, revisar el texto consolidado y citar el artículo exacto.

Para muchos abogados, este proceso consume horas. La IA puede acelerarlo, pero aparece un problema importante: **un despacho no puede enviar alegremente consultas, documentos o datos de clientes a servicios externos**.

El secreto profesional, la confidencialidad y el RGPD no son detalles técnicos. Son requisitos de diseño.

Por eso tiene sentido plantear un asistente jurídico de IA **local, privado y basado en software open source**: los modelos, las leyes, las consultas y las respuestas permanecen dentro de la infraestructura del despacho.

## 🏠 Una arquitectura 100 % local

El stack puede ser relativamente sencillo:

- Un LLM open source ejecutado en local.
- Un servidor como LM Studio u Ollama, preferiblemente con una API compatible con OpenAI.
- Un modelo local de embeddings.
- Node.js o Python para la ingesta, la recuperación y la generación de respuestas.
- Un índice léxico y una base vectorial almacenados localmente.

No es necesario depender de APIs en la nube. Tampoco hace falta diseñar un modelo desde cero.

El flujo básico es:

1. El usuario formula una pregunta.
2. El sistema busca los fragmentos legales más relevantes.
3. Esos fragmentos se entregan al LLM como contexto.
4. El modelo responde utilizando únicamente ese contexto.
5. La interfaz muestra las citas y los enlaces oficiales.

La parte difícil no es hacer que el modelo genere texto. La parte difícil es **recuperar la norma correcta de forma consistente**.

## 🔎 RAG: buscar antes de responder

Preguntar directamente a un LLM qué dice una ley es una mala idea.

Los modelos pueden recordar conceptos jurídicos generales, pero también confundir artículos, mezclar versiones normativas o inventar citas con una seguridad sorprendente. En derecho, una respuesta aparentemente convincente con una referencia falsa es inadmisible.

La alternativa es utilizar **RAG** (*Retrieval-Augmented Generation* o generación aumentada por recuperación).

La idea es sencilla: el LLM no responde “a pelo”. Primero se recupera el texto legal relevante y después se le pide que redacte la respuesta usando exclusivamente esas fuentes.

Un prompt de sistema razonable debería imponer reglas como estas:

- Responde solo con la información incluida en el contexto.
- Cita la fuente de cada afirmación jurídica.
- No inventes artículos, normas ni jurisprudencia.
- Si el contexto no permite responder, indícalo expresamente.
- Diferencia entre lo que dice la norma y cualquier explicación interpretativa.

Esto no elimina por completo las alucinaciones, pero reduce mucho su superficie. Es un diseño anti-alucinación basado en evidencia, no en confiar ciegamente en el modelo.

## 📚 La calidad empieza en los datos

En España, una fuente natural es la API de datos abiertos del BOE. Permite obtener legislación oficial y, cuando está disponible, su texto consolidado.

Para construir el corpus conviene:

1. Descargar el texto consolidado oficial.
2. Conservar los metadatos de la norma.
3. Dividir el contenido por artículos y otras unidades jurídicas.
4. Asociar cada fragmento con su cita exacta.
5. Guardar el enlace a la fuente oficial.
6. Registrar la fecha o versión del texto incorporado.

Trocear por artículos suele ser mejor que aplicar cortes arbitrarios por número de caracteres. El artículo es una unidad jurídica reconocible y facilita producir citas comprensibles.

Cada fragmento debería incluir, como mínimo:

- Título oficial de la norma.
- Identificador de la disposición.
- Número y título del artículo.
- Rúbricas de título, capítulo o sección.
- Texto completo del artículo.
- Enlace oficial.
- Información temporal relevante.

El texto de las leyes es de dominio público, lo que facilita su reutilización. Aun así, hay que cuidar la procedencia, la vigencia y la trazabilidad: un corpus jurídico desactualizado puede ser más peligroso que no tener buscador.

## 🧭 Por qué la búsqueda vectorial no basta

Los embeddings permiten buscar por significado. Son útiles cuando la pregunta y la norma expresan una misma idea con palabras diferentes.

Sin embargo, en derecho los términos exactos importan mucho: números de artículo, denominaciones de delitos, conceptos definidos y expresiones literales pueden cambiar por completo el resultado.

Una búsqueda solo vectorial puede recuperar un artículo conceptualmente parecido y omitir el que contiene la formulación jurídica precisa.

Por eso funciona mejor una **búsqueda híbrida**:

- **BM25** para coincidencias léxicas y términos exactos.
- **Embeddings** para similitud semántica.
- Una estrategia de fusión para combinar y ordenar ambas listas.

BM25 aporta precisión terminológica. Los embeddings aportan comprensión semántica. Juntos suelen superar claramente a cualquiera de los dos por separado.

## 🛠️ Las lecciones que aparecen al escalar

Una demostración con diez leyes puede funcionar muy bien. Los problemas reales aparecen al indexar miles.

### 1. Las normas fundamentales quedan sepultadas

Con un corpus grande, disposiciones secundarias pueden competir con el Código Penal, el Código Civil o las leyes procesales fundamentales.

No basta con medir similitud. Hace falta incorporar un **peso de autoridad** que refleje la relevancia estructural de determinadas normas.

Ese peso no debe sustituir a la búsqueda, pero sí ayudar a desempatar y evitar que una coincidencia incidental desplace a la fuente jurídica principal.

### 2. Las rúbricas también contienen conocimiento

Los nombres de muchos delitos o instituciones jurídicas aparecen en las rúbricas de títulos y capítulos, no necesariamente en el cuerpo del artículo.

Por ejemplo, el artículo que regula una conducta puede no contener literalmente la palabra “hurto”, aunque esté situado bajo una rúbrica dedicada al hurto.

Si solo se indexa el texto del artículo, se pierde una señal fundamental. Hay que enriquecer cada fragmento con su jerarquía normativa: libro, título, capítulo, sección y sus correspondientes rúbricas.

### 3. El español necesita normalización lingüística

Un buscador léxico ingenuo puede tratar “hurto” y “hurtos” como términos diferentes. Lo mismo ocurre con variaciones de género, número y ciertas formas flexionadas.

Sin stemming, lematización o una estrategia equivalente para español, el *recall* cae de forma silenciosa.

Conviene conservar el texto original para mostrarlo y, en paralelo, generar una representación normalizada para la búsqueda.

### 4. El modelo de embeddings es una decisión crítica

Un embedder pequeño, entrenado principalmente en inglés, puede funcionar en ejemplos genéricos y fallar de manera seria con español jurídico.

Cambiar a un modelo multilingüe potente, como uno de la familia o el tipo de `bge-m3`, puede ser la mayor mejora de todo el sistema.

Antes de ajustar prompts durante semanas, merece la pena comprobar si el espacio vectorial representa correctamente el idioma y el dominio.

### 5. El reranking también puede engañar

Es posible utilizar un LLM para reordenar los candidatos recuperados. A veces mejora mucho los primeros resultados.

Pero existe un riesgo: ajustar el reranker hasta que funciona perfectamente con las veinte preguntas que usamos durante el desarrollo. Eso es *overfitting*, aunque no estemos entrenando formalmente un modelo.

El resultado puede parecer excelente en la demo y degradarse ante consultas nuevas. Hay que evaluar sobre un conjunto amplio y separado.

### 6. Sin métricas, solo tenemos impresiones

Una evaluación útil necesita preguntas con una respuesta canónica conocida: qué norma y qué artículo deberían recuperarse.

Algunas métricas prácticas son:

- **Hit@k**: comprueba si la respuesta correcta aparece entre los primeros `k` resultados.
- **MRR**: premia que el resultado correcto aparezca lo más arriba posible.
- Cobertura por área jurídica, tipo de consulta y dificultad.

También conviene guardar los fallos y clasificarlos: problemas de ingesta, vocabulario, embeddings, ranking, vigencia o generación.

Sin medir, cualquier mejora puede ser solo una demo más convincente.

## ⚠️ La verdad incómoda sobre producción

Ningún RAG jurídico es perfecto al 100 %.

Puede faltar una norma, existir una actualización pendiente, fallar la recuperación o producirse una interpretación incorrecta. Prometer que “la IA siempre acierta” no es una estrategia técnica ni responsable.

El diseño correcto consiste en **mostrar siempre las fuentes utilizadas**, con el artículo, la norma y el enlace oficial, para que el abogado pueda verificar la respuesta.

La IA debe reducir el tiempo de búsqueda y facilitar la navegación por el corpus. La validación jurídica final sigue correspondiendo al profesional.

Eso es lo que diferencia a una herramienta seria de un generador de respuestas plausibles.

## 🚀 Soberanía del dato como ventaja

Construir un asistente jurídico local es viable con herramientas open source y hardware accesible. El reto principal no está en levantar un chatbot, sino en preparar datos fiables, diseñar una recuperación híbrida y evaluar el sistema con rigor.

A cambio, se obtiene algo valioso: **soberanía sobre los datos, control de la infraestructura y trazabilidad de las respuestas**.

¿Dónde crees que está hoy el mayor obstáculo para adoptar IA jurídica local: en la tecnología, en los datos o en la confianza?

#LegalTech #InteligenciaArtificial #RAG #OpenSource #PrivacidadDeDatos
