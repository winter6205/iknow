# Bounded Context Examples

This file holds extended examples that complement the main SKILL.md body. Each example illustrates a real failure mode covered by the acceptance criteria.

## Module Boundary Split

Walkthrough of converting a technical-layer directory layout into a business-capability layout. Each segment corresponds to a documented failure mode.

### Anti-pattern: Technical-layer slicing (violates S1)

```
src/
  controllers/
    OrderController.ts
    BillingController.ts
    InventoryController.ts
  services/
    OrderService.ts
    BillingService.ts
    InventoryService.ts
  repositories/
    OrderRepository.ts
    BillingRepository.ts
    InventoryRepository.ts
```

Problem: changing the order business crosses three directories (controllers/ + services/ + repositories/). One feature change touches one file in three directories. This is the textbook shotgun-surgery smell.

### Correct pattern: Capability slicing (matches S1)

```
src/
  orders/
    OrderController.ts
    OrderService.ts
    OrderRepository.ts
    Order.ts (schema)
  billing/
    BillingController.ts
    BillingService.ts
    BillingRepository.ts
    Invoice.ts
  inventory/
    InventoryController.ts
    InventoryService.ts
    InventoryRepository.ts
    StockItem.ts
```

Benefit: changing the order business stays inside the orders/ directory. One feature change touches N files in one directory. Cross-context communication flows through a published interface, for example orders/api/ordersApi.ts exposing placeOrder(). Other contexts depend on the interface, not on the implementation.

### Parnas 1972 Hidden Decisions

Technical-layer slicing exposes a hidden decision: "we use a layered architecture" (a technical choice). Capability slicing exposes a different hidden decision: "orders, billing, and inventory are three independent business capabilities" (a business fact). With technical layers, a business change forces a technology change (cross-cutting, high fan-out). With capability slicing, a business change stays inside one business module (localized, low fan-out).

## How to Adapt

Any project organized as controllers/services/repositories can be reorganized into orders/billing/inventory using this template. The migration is mechanical: re-parent each file under the capability directory that owns it, then expose a single interface file at the boundary.

See the main SKILL.md for the procedure, acceptance criteria, and verification commands.
