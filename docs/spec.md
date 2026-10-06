**Notification Center Spec**  
Overview  
Below is a spec that you might receive from our product team. We’re looking for code that we’d feel  
comfortable merging into our main branch as a live feature. There are no constraints on approach or  
assistance: use whatever you’d use in the role on a day-to-day basis. Aim to spend 5-6 hours on this  
project; please do not take longer than 8\. Submit your response within 3 business days of receiving this  
packet.  
We encourage thoughtful use of AI-tooling in your workflow. That means:

- We expect rough edges and won’t be compiling your project, running your code, or evaluating

your work line-by-line

- We care more about your process: how you broke apart the problem, considerations you took into

account while designing a solution, steps you took to be confident your code was ready to ship

- Your write-up is just as important as your code. Please don’t skip it to polish the other pieces.

**The stack for this exercise**:

* Runtime: Node.js  
* Language: TypeScript  
* Database: Aurora MySQL  
* HTTP layer: Koa

Please deliver your solution in the form of a link to a public GitHub repository. Include a README.md  
explaining:

* Your workflow: How did you approach the problem? What did you delegate to AI? Where did you push back on its output? What did you do by hand?  
* Architecture decisions & tradeoffs: what did you consider, prioritize, & deprioritize  
*  Concerns: anything you’d flag in real code review or revisit with more time  
* Assumptions: where the spec was ambiguous, what did you decide and why  
* What’s missing for true production readiness

**Engineering Requirements**  
Topline requirements:

* Create a notification center for members  
* There will be 3 types of notifications:  
  * Turn on for accounts with filters (can assume these values all live on an account table):  
    * Country: US or CA  
    * Policy: Monthly, Annual  
    * Relationship status: New Member, Friend, or BFF  
    * Credits: \<1, \>=1,=3, etc.  
  * Mass upload a CSV & send notification to all accountIds  
  * Event trigger: user takes an action that triggers a notification send  
* All notifications are visible for 2 months (static months, not rolling). They are wiped after 2 months.  
* Each notification has:  
  * Icon or image  
  * Headline  
  * Subheadline  
  * Link \- a page on our website  
  * A time stamp that consistently updates based on when it went live (e.g.‘sent 5 minutesago’)  
  * Clicked vs. not clicked state (blue bubble on front end if they’ve never clicked it)  
* When a user goes to the Notification page on our app, they should see their notifications from  
* most recent to least recent

**Logic:**  
Definitions:

* **Active / Inactive**: Making a notification active means that it will go live. Making a notification inactive means that no NEW notifications will go out. The notifications that already went out will not be removed from the front end. (applicable for event notifications and filter notifications only as CSVs are one-time send)  
* **Remove from app functionality**: Making a notification “remove from app” removes the notification from anyone who has seen it already VS. making something “inactive” does not send the notification to anyone new who qualifies. If a notification is removed, no one should see it anymore, even people it has been sent to and seen by

Triggers:  
**Event notifications**:

* Description: Use one of the pre-created events to create a notification:  
  * Shipped  
  * Enrolled  
  * Pre-enroll audiobook available:  
    * Notifications of this kind automatically go live at the purchased audiobook's publication date  
  *  	Delays (see below) will be overwritten by this publication date  
* Delay:  
  * Enter the number of days after the event occurs that you want the notification to appear  
  * If no delay is entered, the notification will send immediately when the event takes place  
  * If a enroll-triggered notification with a delay of 5 should appear 5 days after enroll  
  * NOTE: Preorder Audiobook Purchased events will ignore this delay and go live at the audiobook's publication date  
* Logic: Once a notification is created in admin and made active, when the event selected in the notification is triggered by a user it should surface the notification in the app.  
* Active is editable: YES \- making this active means that the notification will go live for eligible population as soon as the event gets triggered.  
* Timing: Notification appears every time the event gets triggered.  
  * Example: if 2 friends join with my RAF link, I will get 2 notifications.

**Filter notifications**:

* Description: Choose the eligible population using any of the filters (each filter is a multi select):  
  * Policy \- Account must be in one of the selected policies. If no policy selected, all policies are eligible  
  * Relationship status \- Account must be in one of the selected relationship statuses. If no status selected, all statuses are eligible  
  * Min \+ max credits: Account must have a number of credits that falls within the inputted credit range  
    * If a minimum credit count is entered, the account's credits must be greater than or equal to that number.  
    *  If no number entered, no minimum will be checked  
    * If a maximum credit count is entered, the account's credits must be less than or equal to that number. If no number is entered, no maximum will be checked  
  * Country: Account must have one of the country codes selected. If no country code selected, all accounts are eligible  
* Active is editable: YES \- this makes the notification live  
  * If at any point while a notification is active, an account meets all filter criteria, we should send it to them  
* Logic: Notification is only sent once per month if the notification is marked as active (static months, not rolling)  
* Example: If I set a notification for new books for all members with at least one credit on 8/1, on 8/2 there is not another notification triggered for the same eligible people.

**CSV upload**:

* Description: Upload a CSV of account IDs that should see a notification  
* Active is editable: NO \- this flag is not editable  
* Logic: Notification is only sent once at the date indicated in admin. This will be static \- all people on the list will see the notification.  
* Example: If I am a member in the CSV file I get the notification as soon as the date in admin is hit.

 