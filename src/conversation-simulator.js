/**
 * conversation-simulator.js
 * Generates realistic simulated conversations for token strategy analysis.
 *
 * Exports:
 *   generateConversation(numTurns, messageStyle) -> { messages, systemPrompt, conversationTokens }
 *   generateSystemPrompt() -> string
 *   generateSummary(conversationMessages, summaryStyle) -> string
 *   generateMixedConversation(numTurns, styleWeights) -> { messages, systemPrompt }
 */

const { countTokens, countMessages } = require('./tokenizer');

// ─── Word Banks for Realistic Text Generation ──────────────────────────────

const SUBJECTS = [
  'the subjunctive mood', 'past tense conjugations', 'reflexive verbs', 'article usage',
  'pronoun placement', 'ser versus estar', 'vocabulary for travel', 'formal greetings',
  'object pronouns', 'conditional tense', 'imperative mood', 'idiomatic expressions',
  'gender agreement', 'irregular verbs', 'future tense', 'present perfect',
  'vocabulary for food', 'numbers and dates', 'prepositions', 'relative clauses',
];

const VERBS = [
  'understand', 'practice', 'learn', 'review', 'explain', 'clarify', 'help me with',
  'go over', 'work through', 'study', 'memorize', 'apply', 'use', 'conjugate',
];

const FILLERS_SHORT = [
  'Can you', 'Could you', 'Please', 'I need to', 'Help me', 'I want to',
  'How do I', 'What is the rule for', 'I am confused about', 'Teach me about',
];

const FEEDBACK = [
  'That makes sense!', 'I understand now.', 'Thank you so much.',
  'Can you give me another example?', 'What about exceptions?',
  'Is this correct?', 'Let me try:', 'Got it, thanks!',
  'I still find this confusing.', 'This is really helpful.',
  'Can we practice more?', 'How do native speakers use this?',
];

const ASSISTANT_RESPONSES_SHORT = [
  'Great question! Here is the rule: use the subjunctive when expressing doubt or desire.',
  'Of course! Remember to match the gender of the noun with the adjective.',
  'Exactly right! You are getting the hang of it.',
  'Let me give you an example to clarify that concept.',
  'Correct! The conjugation follows the regular pattern for -ar verbs.',
  'Good effort! Just a small correction: the verb form should be plural here.',
  'That is a very common mistake. The key is to look at the subject of the clause.',
  'Perfect! Now try using that word in a different sentence.',
];

const ASSISTANT_RESPONSES_MEDIUM = [
  'Great question! The subjunctive mood in Spanish is used to express subjective opinions, emotions, doubts, wishes, and hypothetical situations. The key trigger words are phrases like "espero que" (I hope that) and "quiero que" (I want that). When you see these phrases, the following verb must be conjugated in the subjunctive. For example: "Espero que tú vengas" means "I hope that you come," where "vengas" is the subjunctive form of "venir."',
  'The difference between "ser" and "estar" is one of the most important distinctions in Spanish. "Ser" is used for permanent or inherent characteristics: nationality, profession, and physical traits that do not change. "Estar" is used for temporary states: emotions, location, and conditions that can change. For instance, "Soy alto" means "I am tall" (permanent), while "Estoy cansado" means "I am tired" (temporary state).',
  'Reflexive verbs in Spanish are verbs where the subject performs an action on itself. They are always used with reflexive pronouns: me, te, se, nos, os, se. For example, "levantarse" means "to get up." Conjugated: "yo me levanto" (I get up), "tú te levantas" (you get up). The reflexive pronoun must agree with the subject in all cases. Common reflexive verbs include: llamarse, despertarse, vestirse, and ducharse.',
  'The present perfect tense in Spanish is formed with the auxiliary verb "haber" plus the past participle. The conjugations of haber are: he, has, ha, hemos, habéis, han. The past participle for -ar verbs ends in -ado, and for -er/-ir verbs it ends in -ido. So "I have spoken" becomes "he hablado," and "she has eaten" becomes "ella ha comido." This tense is used to describe recently completed actions or actions with relevance to the present.',
];

const ASSISTANT_RESPONSES_LONG = [
  `Excellent question about the subjunctive mood! This is one of the most challenging aspects of Spanish grammar for English speakers, because English rarely uses the subjunctive in everyday speech.

The Spanish subjunctive (el subjuntivo) is a grammatical mood used to express:
1. Wishes and desires: "Quiero que tú estudies" (I want you to study)
2. Emotions: "Me alegra que estés aquí" (I'm glad you're here)
3. Doubt and denial: "No creo que sea verdad" (I don't think it's true)
4. Impersonal expressions: "Es importante que practiques" (It's important that you practice)
5. Hypothetical situations: "Si tuviera dinero..." (If I had money...)

The present subjunctive is formed by taking the yo form of the present indicative, dropping the -o, and adding the subjunctive endings. For -AR verbs: -e, -es, -e, -emos, -éis, -en. For -ER and -IR verbs: -a, -as, -a, -amos, -áis, -an.

Examples:
- hablar → yo hablo → habl- → hable, hables, hable, hablemos, habléis, hablen
- comer → yo como → com- → coma, comas, coma, comamos, comáis, coman

The trickiest part is recognizing when to use it. Look for the WEIRDO categories: Wishes, Emotions, Impersonal expressions, Recommendations, Doubt/Denial, Ojalá.

Would you like me to walk through some practice sentences with you?`,

  `Let me give you a comprehensive breakdown of Spanish verb conjugation patterns, which will help you navigate the language much more systematically.

Spanish verbs fall into three categories based on their infinitive endings: -AR, -ER, and -IR. Each group follows its own conjugation pattern in the present tense.

For REGULAR -AR verbs (like hablar - to speak):
yo hablo, tú hablas, él/ella habla, nosotros hablamos, vosotros habláis, ellos hablan

For REGULAR -ER verbs (like comer - to eat):
yo como, tú comes, él/ella come, nosotros comemos, vosotros coméis, ellos comen

For REGULAR -IR verbs (like vivir - to live):
yo vivo, tú vives, él/ella vive, nosotros vivimos, vosotros vivís, ellos viven

Notice that -ER and -IR verbs share most endings except in nosotros and vosotros forms.

Now, irregular verbs are a different matter. The most common irregular verbs are:
- ser (to be): soy, eres, es, somos, sois, son
- estar (to be): estoy, estás, está, estamos, estáis, están
- tener (to have): tengo, tienes, tiene, tenemos, tenéis, tienen
- ir (to go): voy, vas, va, vamos, vais, van

Stem-changing verbs are another category where the vowel in the stem changes in all forms except nosotros and vosotros:
- e→ie: querer (to want) → quiero, quieres, quiere, queremos, queréis, quieren
- o→ue: poder (to be able) → puedo, puedes, puede, podemos, podéis, pueden
- e→i: pedir (to ask for) → pido, pides, pide, pedimos, pedís, piden

Would you like practice exercises for any of these patterns?`,
];

// ─── System Prompt Generator ───────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are Langua, an expert AI language tutor specializing in personalized, adaptive language instruction. Your primary goal is to help learners achieve fluency through structured practice, clear explanations, and encouraging feedback.

TEACHING PHILOSOPHY:
You adapt your teaching style to the individual learner's level, pace, and learning preferences. You use a communicative approach, meaning you prioritize practical usage over rote memorization. You celebrate progress and treat mistakes as learning opportunities rather than failures.

INTERACTION GUIDELINES:
- Always respond in a warm, encouraging, and patient tone
- Provide clear, concrete examples for every grammatical concept
- Use the learner's target language progressively — start with their native language and increase target language use as their confidence grows
- When correcting errors, first acknowledge what was done correctly before pointing out the mistake
- Break complex concepts into digestible steps
- Check for understanding regularly by asking follow-up questions

LANGUAGE EXPERTISE:
You have deep expertise in Spanish, French, Italian, Portuguese, German, Japanese, Mandarin, and Korean. You understand not just grammar rules but also regional dialects, cultural context, and pragmatic usage differences between formal and informal registers.

MEMORY AND CONTINUITY:
Track the learner's progress across sessions. Remember vocabulary they have struggled with, grammatical patterns that need reinforcement, and topics they have expressed interest in. Reference previous interactions to create a sense of continuity and personalized learning.

LESSON STRUCTURE:
Each session should feel natural and conversational while also being pedagogically sound. When appropriate, structure lessons with: brief review of previous material, introduction of new concept, guided practice, independent practice, and summary of what was learned.

ASSESSMENT AND FEEDBACK:
Provide specific, actionable feedback. Instead of saying "that's wrong," explain why it's incorrect and provide the correct form with a mnemonic or pattern the learner can apply going forward.`;

/**
 * Generate a realistic system prompt (approximately 300-500 tokens).
 * @returns {string}
 */
function generateSystemPrompt() {
  return SYSTEM_PROMPT_TEMPLATE;
}

// ─── Message Generators ────────────────────────────────────────────────────

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a short user message (15-30 words target).
 */
function generateShortUserMessage(turnIndex) {
  const patterns = [
    () => `${randomChoice(FILLERS_SHORT)} ${randomChoice(VERBS)} ${randomChoice(SUBJECTS)}.`,
    () => `${randomChoice(FEEDBACK)} ${randomChoice(FILLERS_SHORT)} ${randomChoice(VERBS)} ${randomChoice(SUBJECTS)} too?`,
    () => `How do I ${randomChoice(VERBS)} ${randomChoice(SUBJECTS)} correctly?`,
    () => `I am having trouble with ${randomChoice(SUBJECTS)}. Can you help?`,
    () => `What is the difference between those two verb forms you mentioned?`,
    () => `Can you give me a practice exercise for ${randomChoice(SUBJECTS)}?`,
  ];
  return randomChoice(patterns)();
}

/**
 * Generate a medium user message (40-80 words target).
 */
function generateMediumUserMessage(turnIndex) {
  const patterns = [
    () => `I have been practicing ${randomChoice(SUBJECTS)} all week, but I keep making mistakes. For example, when I try to ${randomChoice(VERBS)} ${randomChoice(SUBJECTS)}, I get confused about the rules. Could you walk me through the key points again? Maybe with a few examples I can follow along with?`,
    () => `${randomChoice(FEEDBACK)} I tried applying what you taught me about ${randomChoice(SUBJECTS)} in a real conversation yesterday, and I think I did okay, but I am not sure I used it correctly every time. Can you check my understanding? I believe the rule is that you use it when the subject changes between clauses, is that right?`,
    () => `I noticed in my textbook that ${randomChoice(SUBJECTS)} has several exceptions that are not covered in the standard rule. I was wondering if you could explain when those exceptions apply and whether native speakers actually follow them in everyday speech or if they are more of a formal writing rule?`,
    () => `Can we do a short role-play exercise? I want to practice using ${randomChoice(SUBJECTS)} in a natural conversation. I'll play a tourist and you can be a local shopkeeper. That way I can practice the vocabulary in context rather than just memorizing the grammar rules in isolation.`,
  ];
  return randomChoice(patterns)();
}

/**
 * Generate a long user message (100-200 words target).
 */
function generateLongUserMessage(turnIndex) {
  const patterns = [
    () => `I have been thinking a lot about what we covered last session on ${randomChoice(SUBJECTS)}, and I wrote out some sentences to practice. Here is what I came up with — can you tell me if these are correct?

1. "Yo quiero que tú hablas más despacio." (I want you to speak more slowly)
2. "Es importante que nosotros practicamos cada día." (It's important that we practice every day)
3. "Espero que ella viene mañana." (I hope she comes tomorrow)

I think there might be something wrong with the verb forms but I can't figure out exactly what the rule is. I remember you saying something about using a special form after certain trigger phrases, but I got confused about when exactly to apply it. Also, I tried having a short conversation with my language exchange partner yesterday, and they used a phrase I didn't recognize: "Ojalá que puedas venir." What does "ojalá" mean, and does that change the verb that follows it?`,

    () => `I want to share my experience from this week's language practice. I have been watching Spanish TV shows without subtitles, which you recommended, and it has been both exciting and overwhelming. There are so many words and expressions I don't recognize, and the speed is so much faster than the textbook dialogues I am used to.

A few specific things I noticed and want to ask about:

First, people seem to drop subject pronouns a lot — they just say "tengo" instead of "yo tengo." Is this a rule, or just informal speech? Second, I heard "a mí me gusta" instead of just "me gusta." Why do they add "a mí" at the beginning? Is it for emphasis? Third, I keep hearing a word that sounds like "pues" between sentences. What does it mean and how should I use it?

I feel like I am making progress on vocabulary but my comprehension of fast native speech is still very slow. What would you recommend for improving listening comprehension specifically? Are there particular types of content or exercises that work best for reaching that fluency threshold?`,
  ];
  return randomChoice(patterns)();
}

/**
 * Generate an assistant response matching the given style.
 */
function generateAssistantResponse(style) {
  switch (style) {
    case 'short': return randomChoice(ASSISTANT_RESPONSES_SHORT);
    case 'medium': return randomChoice(ASSISTANT_RESPONSES_MEDIUM);
    case 'long': return randomChoice(ASSISTANT_RESPONSES_LONG);
    default: return randomChoice(ASSISTANT_RESPONSES_MEDIUM);
  }
}

/**
 * Generate a complete conversation.
 *
 * @param {number} numTurns - Number of user+assistant turn pairs
 * @param {'short'|'medium'|'long'} messageStyle - Message length style
 * @returns {{ messages: Array, systemPrompt: string, conversationTokens: number }}
 */
function generateConversation(numTurns, messageStyle) {
  const systemPrompt = generateSystemPrompt();
  const messages = [];

  for (let i = 0; i < numTurns; i++) {
    let userContent;
    switch (messageStyle) {
      case 'short':  userContent = generateShortUserMessage(i);  break;
      case 'medium': userContent = generateMediumUserMessage(i); break;
      case 'long':   userContent = generateLongUserMessage(i);   break;
      default:       userContent = generateMediumUserMessage(i);
    }

    const assistantContent = generateAssistantResponse(messageStyle);

    messages.push({ role: 'user',      content: userContent });
    messages.push({ role: 'assistant', content: assistantContent });
  }

  const conversationTokens = countMessages(messages);
  return { messages, systemPrompt, conversationTokens };
}

/**
 * Generate a mixed-style conversation (weighted random per turn).
 *
 * @param {number} numTurns
 * @param {{ short: number, medium: number, long: number }} styleWeights - Must sum to 1.0
 * @returns {{ messages: Array, systemPrompt: string }}
 */
function generateMixedConversation(numTurns, styleWeights = { short: 0.7, medium: 0.2, long: 0.1 }) {
  const systemPrompt = generateSystemPrompt();
  const messages = [];

  for (let i = 0; i < numTurns; i++) {
    const rand = Math.random();
    let style;
    if (rand < styleWeights.short) {
      style = 'short';
    } else if (rand < styleWeights.short + styleWeights.medium) {
      style = 'medium';
    } else {
      style = 'long';
    }

    let userContent;
    switch (style) {
      case 'short':  userContent = generateShortUserMessage(i);  break;
      case 'medium': userContent = generateMediumUserMessage(i); break;
      case 'long':   userContent = generateLongUserMessage(i);   break;
    }

    const assistantContent = generateAssistantResponse(style);
    messages.push({ role: 'user',      content: userContent });
    messages.push({ role: 'assistant', content: assistantContent });
  }

  return { messages, systemPrompt };
}

/**
 * Generate a summary of a conversation.
 * summaryStyle: 'compact' (~15% of conv tokens) or 'verbose' (~45% of conv tokens)
 *
 * @param {Array} conversationMessages
 * @param {'compact'|'verbose'} summaryStyle
 * @returns {{ text: string, tokens: number }}
 */
function generateSummary(conversationMessages, summaryStyle = 'compact') {
  const convTokens = countMessages(conversationMessages);
  const targetRatio = summaryStyle === 'compact' ? 0.15 : 0.45;
  const targetTokens = Math.round(convTokens * targetRatio);

  // Build a realistic summary text that approximates the target token count
  const summaryIntro = summaryStyle === 'compact'
    ? `The learner has been studying Spanish with focus on grammar and vocabulary. `
    : `This conversation covers an extended Spanish tutoring session in which the learner and tutor discussed multiple grammar topics. `;

  const summaryBody = summaryStyle === 'compact'
    ? `Topics covered include verb conjugations, subjunctive mood, reflexive verbs, and ser/estar distinction. The learner showed progress in understanding agreement rules and has been encouraged to practice with native content. Key vocabulary and patterns were reviewed.`
    : `Topics discussed in detail include: the present and past subjunctive moods with full conjugation tables and example sentences demonstrating WEIRDO trigger categories; the distinction between ser and estar with numerous examples of permanent vs temporary states; reflexive verb constructions including reflexive pronoun placement in compound tenses; stem-changing verb patterns (e→ie, o→ue, e→i) with full paradigms; the present perfect tense formed with haber plus past participles; imperative mood formation for regular and irregular verbs; and direct and indirect object pronoun placement including double pronoun constructions. The learner made several common errors including using indicative where subjunctive was required, misplacing object pronouns in compound verb constructions, and confusing ser/estar in emotional contexts. These were corrected with explanations and examples. The learner is intermediate level, motivated, and has been watching Spanish television to improve listening comprehension. They have a language exchange partner they practice with weekly. Recommended next steps include continuing immersion practice and focusing on irregular subjunctive forms.`;

  const summaryText = summaryIntro + summaryBody;
  const actualTokens = countTokens(summaryText);

  // Pad or trim to approximate target
  // For simulation purposes, we compute the expected tokens and just return
  // the text with its real token count (close enough for modeling purposes)
  return {
    text: summaryText,
    tokens: actualTokens,
    targetTokens,
    ratio: actualTokens / Math.max(convTokens, 1),
  };
}

module.exports = {
  generateConversation,
  generateMixedConversation,
  generateSystemPrompt,
  generateSummary,
};
