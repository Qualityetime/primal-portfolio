// Earlier behavior regressions isolate one boar under their original conditions.
// Hunting 1.2.2 tests leave both live and exercise their interaction with all four
// hunters; no production code has a single-animal compatibility path.
export function isolateBoar(hunt) {
  for (const animal of hunt.animals.slice(1)) Object.assign(animal, { x: 32, z: 32, health: 0, state: 'dead', meat: 0 });
  return hunt.animals[0];
}
