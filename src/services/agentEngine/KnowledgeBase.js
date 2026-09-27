export class KnowledgeBase {
  constructor() {
    // Simulated built-in coding knowledge that reduces hallucination
    // A production version would load this from an indexed database or vector store.
    this.coreKnowledge = {
      'solid': 'SOLID principles: Single Responsibility, Open-Closed, Liskov Substitution, Interface Segregation, Dependency Inversion. Favor composition over inheritance. Keep classes small and focused.',
      'react-19': 'React 19 introduces actions, useActionState, useFormStatus, and useOptimistic. Server components are now mainstream. Avoid class components.',
      'stripe-subscriptions': 'Stripe subscriptions use the SetupIntent API or Checkout Sessions. You need a Price ID and a Customer ID to create a subscription.',
      'general-ui': 'Good UI principles: 1) Typography matters (use inter or roboto). 2) Spacing should be consistent (4px/8px grid). 3) Contrast for accessibility. 4) Use clear visual hierarchy.',
      'architecture-patterns': 'Common patterns: MVC (Model-View-Controller), Event-Driven, Microservices, Repository Pattern. Use Repository to abstract database logic.',
      'python-testing': 'In Python, prefer pytest for testing. Write tests in a tests/ directory. Use fixtures instead of setup/teardown methods.',
      'javascript-performance': 'Avoid memory leaks by cleaning up event listeners. Use functional array methods (.map, .filter) but be aware of iteration costs in hot loops.'
    };
  }

  searchCoreKnowledge(query) {
    const q = query.toLowerCase();
    const results = [];
    for (const [key, value] of Object.entries(this.coreKnowledge)) {
      if (key.includes(q) || value.toLowerCase().includes(q)) {
        results.push({ topic: key, content: value, source: 'CORE_KNOWLEDGE' });
      }
    }
    return results;
  }
}
export const knowledgeBase = new KnowledgeBase();
