export class UserPreferences {
  constructor(storageKey = 'prime_ai_prefs') {
    this.storageKey = storageKey
    this.prefs = {
      language: 'auto',
      framework: 'auto',
      style: 'standard'
    }
  }

  load() {
    try {
      const data = localStorage.getItem(this.storageKey)
      if (data) this.prefs = JSON.parse(data)
    } catch {
      // default
    }
  }

  save() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.prefs))
  }
}
