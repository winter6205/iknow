/**
 * Sum the even numbers in a list.
 *
 * Returns 0 for an empty array or when no even numbers are present.
 * The input array is not mutated.
 */
export function sumEven(numbers: readonly number[]): number {
  return numbers.reduce((acc, n) => (n % 2 === 0 ? acc + n : acc), 0);
}
