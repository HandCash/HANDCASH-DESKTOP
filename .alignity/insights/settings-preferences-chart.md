---
name: settings-preferences-chart
when: changing Settings preferences or continuing its chart-first refactor
if: src/machines/settingsPreferencesMachine.ts
---
Appearance and sound use settingsPreferencesMachine with a tagged domain choice and a subscribed persistence port; React only projects it.
Navigation, accepted coins, fiat, updates and child panels retain their existing owners; migrate coherent slices without duplicating their state.
