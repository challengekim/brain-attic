# Plain-language rules for explanations

Used by `attic teach` and the `attic-teach` skill. Two sources, combined:

- **ISO 24495-1:2023 Plain language, Part 1** (https://www.iso.org/standard/78907.html).
  Works for most written languages, including Korean. Four governing principles:
  1. **Relevant**: readers get what they need.
  2. **Findable**: readers can easily find what they need.
  3. **Understandable**: readers can easily understand what they find.
  4. **Usable**: readers can easily use the information.
- **ASD-STE100 Simplified Technical English** (https://asd-ste100.org). Built so that aircraft
  maintenance staff do not misread instructions. Karpathy suggested asking LLMs to explain in it,
  or "80% of the way to ASD-STE100" when the full spec is too strict
  (https://x.com/karpathy/status/2105819303471976479).

The goal is **no second interpretation**, not "simple words". ELI5 hides what was left out.
These rules make gaps visible.

## Writing rules (apply in any language)

1. Start with what the reader needs to do or decide. Put the purpose first. (Relevant)
2. Use headings and short sections. One topic per section. (Findable)
3. Use active voice. Say who does what.
4. One instruction or one claim per sentence. Split long sentences.
5. Use one name for one thing. Do not switch to a synonym later.
6. Do not stack nouns. Write out the relation between words.
7. Put the condition first: "If X, do Y."
8. Put lists of steps or parts in a vertical list.
9. Keep technical terms. Define each term once, at first use.
10. Give one concrete example for each abstract idea. (Usable)
11. Show the structure: what are the parts, and how do they connect? Draw it when a diagram is clearer.
12. End with what the reader can now do with this.

## Self-check before output

- Can a reader find the main point in the first two sentences?
- Does any sentence have two possible meanings? Rewrite it.
- Is every term used with exactly one meaning?
- Is there at least one example and one "what would break if this were missing"?
