import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File, Change } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const FRAMEWORK: string = core.getInput("framework"); // New input for framework

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
    owner: string,
    repo: string,
    pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
    parsedDiff: File[],
    prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function getRailsGuidelines(): string {
  return `
- **Environment Specific Code**: Avoid hard-coding values. Use configuration files or environment variables.

- **Legacy Code**: Remove hard-coded values, clean up unused code, and ensure cross-environment compatibility.

- **Code Quality**: Adhere to Ruby and Rails Style Guides. Use Rubocop.

- **OOP Principles**: Follow SOLID principles.

- **Methods**: Keep methods concise. Use guard clauses and refactoring to reduce complexity.

- **Variables**: Use clear and descriptive names within appropriate scope.

- **File Structure**: 
  - \`app/\`: Domain-specific code.
  - \`lib/\`: Generic Ruby code.

- **Keyword Arguments**: Prefer keyword arguments for readability.

- **Service Layer**: Encapsulate business logic within services.

- **Database Performance**: Avoid N+1 queries. Use \`includes\` or \`preload\`. Index frequently queried columns and use bulk operations.

- **Safe Migrations**: Avoid models in migrations. Use plain SQL and commit \`structure.sql\`. Use \`LHM\` for complex migrations.
  `;
}

function getAngularGuidelines(): string {
  return `
- **Component Structure**: Ensure components are small and focused on a single responsibility. Follow the Angular style guide for component structure.

- **Module Organization**: Organize modules to keep related functionalities together. Use feature modules for distinct features.

- **Service Usage**: Use services for business logic and data access. Keep components focused on presentation logic.

- **Reactive Programming**: Prefer the use of RxJS for asynchronous operations. Ensure proper management of subscriptions to avoid memory leaks.

- **Templates**: Keep templates clean and readable. Use Angular directives (\`*ngIf\`, \`*ngFor\`) appropriately.

- **Change Detection**: Optimize change detection by using \`OnPush\` strategy where possible to improve performance.

- **Forms**: Use Reactive Forms for complex forms and Template-driven forms for simpler ones. Ensure proper validation.

- **Routing**: Use the Angular Router for navigation. Ensure routes are organized and lazy load modules where appropriate.

- **Dependency Injection**: Use Angular's dependency injection to manage dependencies. Avoid creating instances manually.

- **Testing**: Ensure comprehensive unit tests for components, services, and other classes. Use Jasmine and Karma for testing.
  `;
}

function getAngularJSGuidelines(): string {
  return `
- **Component Structure**: Ensure components follow a single responsibility principle. Organize code using modules.

- **Controller Usage**: Minimize the use of controllers. Prefer directives and services.

- **Scope Management**: Avoid excessive use of \`$scope\`. Prefer using \`controllerAs\` syntax and bind properties to the controller.

- **Service Usage**: Use services and factories for business logic. Keep controllers lean.

- **Templates**: Keep templates clean. Use directives to encapsulate reusable components.

- **Dependency Injection**: Use AngularJS dependency injection to manage dependencies. Avoid creating instances manually.

- **Performance**: Optimize watchers and digest cycles. Use one-time bindings where possible.

- **Testing**: Ensure comprehensive unit tests for controllers, services, and directives. Use Jasmine and Karma for testing.
  `;
}

function getCypressGuidelines(): string {
  return `
- **Test Structure**: Organize tests in a logical structure. Use \`describe\` and \`it\` blocks to structure test cases.

- **Selectors**: Use data attributes for selecting elements (\`data-cy\`). Avoid using selectors based on CSS or HTML structure which may change.

- **Assertions**: Use appropriate assertions to verify application behavior. Avoid excessive assertions in a single test.

- **Test Data**: Use fixtures and factories for test data. Avoid hardcoding data within tests.

- **Commands**: Use custom Cypress commands to reuse common test logic. 

- **Error Handling**: Ensure tests handle errors gracefully and provide meaningful error messages.

- **Performance**: Optimize tests to run quickly. Avoid unnecessary steps and redundant tests.

- **Cross-browser Testing**: Ensure tests run across different browsers to verify compatibility.
  `;
}

function getTerraformGuidelines(): string {
  return `
- **Avoid duplicate review comments**: If the same comment applies to multiple lines within the same file or across different files, consolidate your feedback and leave a single comment.
- **Ignore reviewing commentlines**: Ignore reviewing newly added or edited commentlines in the code.
- **Ignore reviewing boolean variables**: Ignore reviewing boolean values in YAML config files.
`;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  let guidelines = "";

  if (FRAMEWORK === "Ruby on Rails") {
    guidelines = getRailsGuidelines();
  } else if (FRAMEWORK === "Angular") {
    guidelines = getAngularGuidelines();
  } else if (FRAMEWORK === "AngularJS") {
    guidelines = getAngularJSGuidelines();
  } else if (FRAMEWORK === "Cypress") {
    guidelines = getCypressGuidelines();
  } else if (FRAMEWORK === "Terraform") {
    guidelines = getTerraformGuidelines();
  }

  return `Your task is to review a pull request for ${FRAMEWORK} code. Follow these instructions:

- Provide your response in JSON format: {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>", "optimizedCode": "<optimized code>"}]}
- Comment only where there is an issue or a suggestion for improvement. No positive comments.
- Use GitHub Markdown format for comments.
- For each issue or suggestion, provide the optimized code snippet.
- Identify specific types of issues:
  - **Security**: Look for vulnerabilities such as SQL injection, XSS, and insecure configurations.
  - **Performance**: Identify potential performance bottlenecks and suggest optimizations.
  - **Maintainability**: Ensure the code is easy to read and maintain. Suggest refactoring if necessary.
  - **Best Practices**: Ensure adherence to best practices specific to ${FRAMEWORK} and the overall project.
  - **Testing**: Verify that the code changes include appropriate tests. If not, suggest adding tests.
  - **Documentation**: Check if the code changes are well-documented. If not, suggest improvements in documentation.

${guidelines}

Review the following code diff in the file "${file.to}", considering the pull request title and description for context:

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
      .map((c) => `${'ln' in c ? c.ln : 'ln2' in c ? c.ln2 : ''} ${c.content}`)
      .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
  optimizedCode: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    // Log the raw response for debugging
    console.log('Raw response:', JSON.stringify(response, null, 2));

    const res = response.choices[0].message?.content?.trim() || "";

    // Extract JSON content from Markdown code block
    const jsonContent = res.match(/```json([\s\S]*)```/)?.[1];

    if (!jsonContent) {
      console.error("Failed to extract JSON content from response.");
      return null;
    }

    // Attempt to parse JSON
    try {
      return JSON.parse(jsonContent).reviews;
    } catch (e) {
      console.error("Failed to parse JSON:", e);
      console.error("Response content:", jsonContent);
      return null;
    }
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
    file: File,
    chunk: Chunk,
    aiResponses: Array<{
      lineNumber: string;
      reviewComment: string;
      optimizedCode: string;
    }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }

    const lineNumber = Number(aiResponse.lineNumber);

    // Find the matching change in the chunk
    const change = chunk.changes.find((c) => {
      if ("ln" in c && c.ln === lineNumber) return true;
      if ("ln2" in c && c.ln2 === lineNumber) return true;
      return false;
    });

    if (!change) {
      console.error(`Line number ${aiResponse.lineNumber} not found in the diff for file ${file.to}`);
      return [];
    }

    const commentLine = "ln" in change ? change.ln : "ln2" in change ? change.ln2 : 0;

    return {
      body: `${aiResponse.reviewComment}\n\n**Optimized Code:**\n\`\`\`${FRAMEWORK === 'Ruby on Rails' ? 'ruby' : FRAMEWORK === 'Cypress' ? 'javascript' : 'typescript'}\n${aiResponse.optimizedCode}\n\`\`\``,
      path: file.to,
      line: commentLine,
    };
  });
}

async function createReviewComment(
    owner: string,
    repo: string,
    pull_number: number,
    comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
      .getInput("exclude")
      .split(",")
      .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
        minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
