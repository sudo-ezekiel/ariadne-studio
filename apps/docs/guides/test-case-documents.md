---
title: Maestro test cases in Excel, HTML or Markdown
description: Export a Maestro test case as an Excel, HTML or Markdown document with preconditions, steps, expected results and screenshots.
---

# Test case documents

Hand over a document that matches the flow exactly, without writing it twice.

## Export

On an opened case, use **Test case document: Excel, HTML, Markdown**. For the whole project, use **Export all cases** above the saved cases. Either writes the document to `exports/` and downloads it.

![The HTML test case document of a case, with its steps and a screenshot after each one](/shots/test-case-document.png)

## The formats

- **Excel** (`.xlsx`): a "Cases" sheet (name, case id, app, preconditions, step count, end checks, last run, muted) and a "Steps" sheet with one row per step: case, step, action, expected result, screenshot path. Preconditions and the end checks get rows of their own there. It opens in Excel, LibreOffice and Google Sheets.
- **HTML**: one page per case with the preconditions, numbered steps, expected results, end checks and the screenshot after each step, all in one file. It prints to PDF and opens in Word.
- **Markdown**: the same content, with screenshots linked from `exports/` to `evidence/`.

## What the words come from

Actions use the step's title when it has one. The expected result is the step's note, or for a check step what it checks.

So the way to better documents is **Title and note** on each step, see [Edit and chain cases](/guides/edit-and-chain#title-and-note).

Documents are built from the case JSON, so they are always in step with the flow.

## Where the files go

```
exports/<caseId>.xlsx      one case; also .html and .md
exports/test-cases.xlsx    every case; also .html and .md
```

`exports/` is out of version control in a new project.

## Privacy

Documents contain the recorded screenshots, and the HTML file carries them inside it. Saved values stay out: a typed secret appears as "the PASSWORD value from .env".
