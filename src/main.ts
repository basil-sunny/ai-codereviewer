import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File, Change } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const FRAMEWORK: string = core.getInput("framework");

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

async function getExistingComments(
    owner: string,
    repo: string,
    pull_number: number
): Promise<Array<{ path: string; line: number; body: string }>> {
  const commentsResponse = await octokit.pulls.listReviewComments({
    owner,
    repo,
    pull_number,
  });
  return commentsResponse.data
      .filter(comment => comment.line !== undefined)
      .map(comment => ({
        path: comment.path,
        line: comment.line!,
        body: comment.body,
      }));
}

async function analyzeCode(
    parsedDiff: File[],
    prDetails: PRDetails,
    existingComments: Array<{ path: string; line: number; body: string }>
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  // Log the parsed diff for debugging
  console.log("Parsed Diff:", JSON.stringify(parsedDiff, null, 2));

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        for (const comment of newComments) {
          console.log("Processing comment:", comment);
          const duplicate = existingComments.some(
              existingComment =>
                  existingComment.path === comment.path &&
                  existingComment.line === comment.line &&
                  existingComment.body.trim() === comment.body.trim()
          );
          if (!duplicate) {
            comments.push(comment);
          } else {
            console.log("Duplicate comment found, skipping:", comment);
          }
        }
      }
    }
  }
  console.log("Final comments to add:", JSON.stringify(comments, null, 2));
  return comments;
}

function getRailsGuidelines(): string {
  return `
- Avoid Environment Specific Code:
  Developer contributes the code that behaves consistently. So that code contribution is supposed to be working from every environment.
  Example:
  This has to be configurable value instead of hard coded with Rails environment:
  \`\`\`ruby
  from_address = Rails.env.production_shiji? ? 'StayNTouch@notice.shijicloud.com' : 'no-reply@stayntouch.com'
  \`\`\`

- Legacy Code Review:
  There is a chance to have the wrong original approach that can be implemented in the past. There are a few patterns you need to pay attention to when you contribute or review the code.
  - Avoid Hard-coded values for configurable or has security risk into repo (e.g.: infrastructure information, credential, 3rd party vendor's token).
  - Code contribution is supposed to be working from every environment.
  - Unused code or canceled implementations are supposed to be cleaned up.
  - When you find suspicious code communicate with co-developers and QA to review and make a refactoring plan.

- Code Style:
  Follow the community-driven Ruby Style Guide and the complementary Rails Style Guide. Use the Rubocop gem and editor plugin to guide development within these rules.

- Object Oriented Programming:
  Follow the principles of this methodology, including the popular SOLID design principles:
  - Single-responsibility principle: A class should only have a single responsibility.
  - Open–closed principle: Software entities should be open for extension but closed for modification.
  - Liskov substitution principle: Objects in a program should be replaceable with instances of their subtypes without altering the correctness of that program.
  - Interface segregation principle: Many client-specific interfaces are better than one general-purpose interface.
  - Dependency inversion principle: Depend upon abstractions, not concretions.

- Methods:
  Methods should be concise and are subject to ABC (assignments, branches, and conditions) metric for enforcement. Some options for reducing complexity include:
  - Guard clauses
  - Exit gates for conditional returns
  - Polymorphism
  - ConsolidateConditional refactoring of multiple branch conditions
  - DecomposeConditional refactoring to extract boolean expressions to dedicated methods for reuse
  - Dedicated libraries for deep decision trees with many conditions and possible responses
  - Conditional patterns can use a Strategy pattern with a Hash of Lambdas

- Variables:
  The purpose of a variable is to know things. Within an object, the purpose of a variable will drive what the scope should be of that variable. When defining instance level variables in a method, the purpose should be to either manipulate an already existing property of that class object or set a property. It should not be used simply to avoid passing arguments to a method within the same instance.

- File structure:
  - app/: This directory holds all domain-specific code. If it applies to our business domain, it should be under this directory.
  - lib/: This directory is for anything that is not domain-specific. Any code in this directory should be generic Ruby and not dependent on our application.

- Keyword Arguments vs Option Hashes:
  Use keyword arguments instead of option hashes for better readability and maintainability.
  Example:
  \`\`\`ruby
  # bad
  def some_method(options = {})
    bar = options.fetch(:bar, false)
    puts bar
  end
  # good
  def some_method(bar: false)
    puts bar
  end
  \`\`\`

- Optional argument passing:
  A function is a block of organized, reusable code that is used to perform a single, related action. Functions provide better modularity for your application and a high degree of code reusing. The following code does not follow that principle:
  \`\`\`ruby
  # bad
  def make_cc_payment(options)
    opts = options[:opts]
    amount = options[:amount].to_f
    payment_method = options[:credit_card]
    is_emv_request = options[:is_emv_request]
    request_options = {
      amount: amount,
      source: self,
      payment_method: payment_method,
      type: is_emv_request == true ? 'sale_terminal' : 'sale',
      checkin_date: arrival_date,
      checkout_date: dep_date,
      room_rate: average_rate_amount,
      guest_name: cc_guest_name,
      currency_code: hotel.default_currency.try(:value),
      swiped_card: opts[:card_data],
      workstation: options[:workstation],
      credit_card_transaction_id: opts[:credit_card_transaction_id],
      auth_code: options[:auth_code]
    }
    add_auth_and_settlement_options(options, request_options)
    hotel.cc_payment_processor(payment_method).process(request_options)
  end
  \`\`\`

- Consistent Classes:
  Follow a consistent structure for class definitions.
  Example:
  \`\`\`ruby
  class Person
    # extend and include go first
    extend SomeModule
    include AnotherModule

    # inner classes
    CustomError = Class.new(StandardError)

    # constants are next
    SOME_CONSTANT = 20

    # afterwards we have attribute macros
    attr_reader :name

    # followed by association macros
    belongs_to :country
    has_many :authentications, dependent: :destroy

    # and validation macros
    validates :name

    # next we have callbacks
    before_save :cook
    before_save :update_username_lower

    # other macros should be placed after the callbacks
    has_enumerated :enum_attr
    accepts_nested_attributes_for :something

    # scopes
    scope :company_cards, -> { with_account_type(:COMPANY) }

    # public class methods are next in line
    def self.some_method
    end

    # initialization goes between class methods and other instance methods
    def initialize
    end

    # followed by other public instance methods
    def some_method
    end

    # protected and private methods are grouped near the end
    protected
    def some_protected_method
    end

    private
    def some_private_method
    end
  end
  \`\`\`

- Service Layer:
  The service layer should be used to store all model-related business logic for the application. No business logic should be present in the controller, job, model, or view any further. These layers should be used as follows:
  - Controller: Accepts the request, extracts parameters, calls services, manipulates models (simple queries only), renders response.
  - Job: Used by resque background jobs. Calls services and manipulates models.
  - Model: Defines attributes, associations, scopes, and simple instance methods to format the data.
  - View: Translates the model data and service output into response attributes.
  - Service: Uses models and other services to implement business logic for a single operation.

- When to Use a Service:
  If any of the following are true:
  - The operation relates to a domain concept that is not a natural part of an Entity or Value Object
  - The interface is defined in terms of other elements in the domain model
  - The operation is stateless
  - Complex finder logic

  Examples: Check In Reservation, Check Out Reservation, Create Reservation, Change Stay Dates, Make Payment, ReservationFinder, etc.

- When Not to Use a Service:
  If any of the following are true:
  - Simple one-line read/write queries via ActiveRecord
  - Converting Controller / Job attributes to what the service needs
  - Simple model scopes are generally better suited to store the reusable query condition
  - Custom model methods can be used to convert an attribute
  - View objects (serializers, jbuilder) can be used to render the controller response
  - When the logic is a general utility and does not include any business logic, this should be a lib

  Examples: Get reservation by id, staycard view object, sum values

- Migrating to a Service:
  - Analyze the code for all entry points into the feature, including controllers, resque jobs, and sneakers jobs.
  - Document the entry points and processes.
  - Discuss with an architect and product owner.
  - Implement the service.
  - Write test cases.
  - Move all entry points to use the service.
  - Remove all existing duplicated code.

- Service Conventions:
  - Gemfile: Ensure the snt gem from the rover-common repo is included.
  - Directory & Filename: Services should be under app/services with class names ending in Service.
  - Calling a Service: Initialize an instance and call the "call" method.
  - Stateless: Each service should be stateless and object-oriented.
  - Base Class: All services must extend from SNT::Core::Services::Base.

- Logging:
  Logs should be informative and useful, but should not be too repetitive or long. Log any important keywords that would help search for it. Choose an appropriate logging level (debug, info, warn, error, or fatal) that correctly describes the scenario at hand.

- Rake Tasks:
  Add logger/puts to print the total time taken to run the rake task. Run the rake task in prod-test environment and update the details in the JIRA ticket.

- Seeds:
  All production-ready reference data should be inserted via seeds. Seeds should be populated during "test:prepare" rake task. Ensure that seeds do not duplicate data nor fail if data is already present.

- Database Performance:
  - Avoid N+1 queries.
  - Use the bullet gem to help identify the N+1 queries.
  - Use the Rails ActiveRecord method includes to pre-load the associations in one query.
  - Consolidate repetitive queries into one query by joining tables and selecting appropriate columns.
  - Avoid full table scans by adding an index or updating the query to use an existing index.
  - Bulk insert/update/delete many changes in a single SQL statement and avoid N+1 writes.
  - Use the activerecord-import gem to insert many records in bulk.
  - Batch the writes to avoid a SQL statement that is too big.
  - Throttle batch writes with a short delay to avoid replication lag.
  - Load test the changes with the maximum expected data.

- Safe Migrations:
  - Avoid models in migrations.
  - Use plain SQL to avoid conflicts with changes to the model that occur after the migration was created.
  - Use LHM to migrate certain schema changes to avoid table locking.
  - Always commit structure.sql schema changes.
  - Avoid looping in migrations.
  - Use decimal(10,2) for amounts.
  - Notify architects & release team of long migrations.
    `;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  let guidelines = "";

  if (FRAMEWORK === "Ruby on Rails") {
    guidelines = getRailsGuidelines();
  }

  return `Your task is to review pull requests for ${FRAMEWORK} code. Instructions:
- Provide the response in the following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment on the code.
- IMPORTANT: NEVER suggest adding comments to the code.
${guidelines}

Review the following code diff in the file "${file.to}" and take the pull request title and description into account when writing the response.
  
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

    let jsonContent: string | null = null;

    // Check if the response is in a code block
    const codeBlockMatch = res.match(/```json([\s\S]*)```/);
    if (codeBlockMatch) {
      jsonContent = codeBlockMatch[1];
    } else {
      // If not, assume the response is direct JSON
      jsonContent = res;
    }

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
      body: aiResponse.reviewComment,
      path: file.to,
      line: commentLine,
    };
  });
}

async function createReviewComment(
    owner: string,
    repo: string,
    pull_number: number,
    comments: Array<{ body: string; path: string; line: number }>,
    commit_id: string
): Promise<void> {
  const validComments = comments.filter(comment => comment.path && comment.line > 0 && comment.body.trim() !== "");

  if (validComments.length === 0) {
    console.log("No valid comments to add");
    return;
  }

  console.log("Attempting to create review comments:", JSON.stringify(validComments, null, 2));

  for (const comment of validComments) {
    try {
      await octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number,
        body: comment.body,
        path: comment.path,
        line: comment.line,
        side: 'RIGHT', // Ensure the comment is on the right side of the diff
        commit_id, // Include commit_id in the request
      });
    } catch (error) {
      console.error("Error creating review comment:", error);
      console.log("Request data:", {
        owner,
        repo,
        pull_number,
        comment,
        commit_id,
      });
    }
  }
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  let commit_id: string;

  if (eventData.action === "opened") {
    diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
    );
    commit_id = eventData.pull_request.head.sha;
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
    commit_id = newHeadSha;
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  console.log("Parsed Diff:", JSON.stringify(parsedDiff, null, 2)); // Log parsed diff for debugging

  const excludePatterns = core
      .getInput("exclude")
      .split(",")
      .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
        minimatch(file.to ?? "", pattern)
    );
  });

  const existingComments = await getExistingComments(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
  );

  const comments = await analyzeCode(filteredDiff, prDetails, existingComments);
  if (comments.length > 0) {
    await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments,
        commit_id // Pass commit_id to the function
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
