---
name: groceries
description: Get groceries into the owner's Amazon Fresh or Whole Foods cart. Use when the owner asks to order groceries, restock, shop for a recipe or a week of meals, or says what the house is out of. Builds the list from what they said and their usual items in memory, makes one cart link with amazon_grocery_cart, and leaves checkout to them.
---

# Groceries

## The list

From what they asked, plus memory (`memory_read`): their usual items, brands,
dietary notes, and what the household goes through. A recipe or "meals for the
week" becomes its ingredients. Don't ask what you can sensibly assume; say what
you assumed in your result.

Quantities in plain units: count, lb, oz, gallon, quart, pint or dozen.

## The cart

1. Pick the store: Amazon Fresh by default; Whole Foods when they ask for it, or
   for milk (Fresh never finds milk).
2. Call `amazon_grocery_cart` with the whole list. It makes one link that shows
   each item matched at their prices, puts it on a page, and returns the page.
3. Pin an exact product (`asin`) only when memory has one for a usual item; a
   pinned item always lands at quantity 1, so say so if they need more.

## The result

Say how many items and the store, anything to check (from the tool's notes), and
that the link is in their email: they tap "Add selected items to cart", then
check out. Never check out for them; never read the link aloud.

When they settle on usual items or a brand, the memory worker keeps it.
