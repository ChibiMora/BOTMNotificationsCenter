Core Entities:  
New tables needed:  
notifications

- id INT AUTO\_INCREMENT PRIMARY KEY,  
- image\_key  VARCHAR(1024) NOT NULL,  
- headline  VARCHAR(255) NOT NULL,  
- subheadline VARCHAR(255) NOT NULL,  
- link\_path VARCHAR(2048) NOT NULL,  
- active BOOLEAN NOT NULL,  
- type INT NOT NULL,  
- went\_live\_at DATETIME,  
- delay INT   
- created\_at DATETIME NOT NULL DEFAULT CURRENT\_TIMESTAMP;  
- CONSTRAINT fk\_notifications\_type FOREIGN KEY (notifications\_type) REFERENCES notifications\_type(id)

notification\_types

- id INT AUTO\_INCREMENT PRIMARY KEY,  
- name VARCHAR(255) NOT NULL,  
- 

notifications\_accounts

- notifications\_id INT NOT NULL,  
- account\_id  INT NOT NULL,  
- is\_clicked BOOLEAN NOT NULL DEFAULT FALSE,  
- Hide BOOLEAN NOT NULL DEFAULT TRUE  
- sent BOOLEAN NOT NULL DEFAULT FALSE  
- CONSTRAINT fk\_notifications\_id FOREIGN KEY (notifications\_id) REFERENCES notifications(id)

Notifcations\_filters

- notifications\_id  INT  
- Policy STRING  
- Relationship STRING  
- Credits INT  
- Country STRING  
- CONSTRAINT fk\_notifications\_id FOREIGN KEY (notifications\_id) REFERENCES notifications(id)

APIs:

INTERNAL:  
GET /notifications

- This would gather all the notifications in last 2 months  
- Must be paginated  
- Filterable?? (by type and date)  
- Body received:  
  - {‘headline’: string // the notification headline  
  - , ‘subheadline’: string // the notification subheadline  
  - , ‘type’: string // the notification type  
  - , ‘createdAt’: string // when the notification was created in MM-YYYY format,  
  -  ‘liveDate’:  string // when the notification goes/went live in MM-YYYY format  
  - ‘isActive’: bool // if the notification is currently active}  
- 200 OK status  
- Possibly cache the results for quicker loading next

GET /notifications/:id

- Gets information for specific notification:  
  - Body received:  
    - {‘image’: string // the completed url link to the img  
    - ‘headline’: string // the notification’s headline  
    - ‘subheadline’: string // the notification’s subheadline  
    - ‘link’: string // the completed url to the link   
    - ‘isActive’: bool // if the notification is currently active NOT REQUIRED (since csv doesnt have this)  
    - ‘createdAt’: string // when the notification was created in MM-YYYY format,  
    -  ‘liveDate’:  string // when the notification goes/went live in MM-YYYY format  
    - ‘type’: string // what type of notification }  
  - 200 ok status 

POST /notifications

- This would initiate the creation of the notifications ONLY VIA WEBSITE  
- Expects the following body  
  - {‘image’: string // the completed url link to the img REQUIRED  
  - ‘headline’: string // the notification’s headline REQUIRED  
  - ‘subheadline’: string // the notification’s subheadline REQUIRED  
  - ‘link’: string // the completed url to the link REQUIRED  
  - ‘isActive’: bool // if the notification is currently active NOT REQUIRED (since csv doesnt have this)  
  - ‘type’: string // what type of notification either event or filter REQUIRED  
    - ‘filters’: object // ONLY REQUIRED IF TYPE IS FILTER  
      - ‘country’: string // either ‘usa’, ‘ca’, or ‘both’,  
      - ‘policy’: string // either ‘monthly’, ‘annual’ or ‘both’  
      - ‘relationStatus’: string // either ‘newMember’, ‘friend’ or ‘bff’ or ‘all’  
      - ‘credits’: object MUST HAVE ONE OF THE BELOW   
        - ‘minimum’: integer    
        - ‘Maximum’: integer  
  - ‘eventTrigger’: string // what event will trigger this notification ONLY REQUIRED IF TYPE IS EVENT  
  - ‘Delay’: integer  NOT REQUIRED BUT ONLY ALLOWED ON EVENT TYPE  
  - }  
  - Return a 201 on success  
- Need to use workers for this to be able to batch sending out notifications, if active  
- 

Errors:   
400: if a required field is not inputted or incorrect extras for the types {‘error’: ‘VALIDATION\_ERROR’, ‘message’:}  
401:  user is not logged in { “error”: “UNATHORIZED”}

POST /notifications/imports

- This would initiate the creation of the notifications ONLY VIA CSV  
- Expect a csv the following as the columns  
  - accountID:  integer  
  - Image: string  
  - Headline: string  
  - Link: string  
  - liveDate: string   
  - Return a 201 on success  
- Need to use workers for this to be able to batch sending out notifications, if active  
-   
- 

Errors:   
400: if a required field is not inputted or incorrect extras for the types {‘error’: ‘VALIDATION\_ERROR’, ‘message’:}  
401:  user is not logged in { “error”: “UNATHORIZED”}

PUT /notifications/:id 

- If need to change the isActive or remove  
  - Expects one or the other  
  - {“isActive”: bool,  
  - ‘Remove’:  true}  
- Returns a 200  
- Need to use workers for this to be able to batch sending out notifications, if active  
- 

Errors:   
401:  user is not logged in { “error”: “UNATHORIZED”}  
404: Notification does not exist {‘error’: “NOT\_FOUND”}

- We need a chron job that runs monthly (static vs rolling) that checks for notifications that were created 2months ago and set them to either inactive or straight deletes  
  - (maybe create a new table of expired\_notifications if we need to see back to them)  
- Do we have a chron job that checks delay??  
- We need to hook up parts of the code base that will trigger event trigger, however different logic for each piece: so the shipped/pre-enroll right away or according to delay (if relevant) and for enrolled each time. This can be sent to a worker to send out notifications  
- Filter I guess we can send again the following month if still active so at the start of a nw month need a job to reset the sent cols in the notification\_account table for all active filter notifications. And send. How does this help us send to anyone new who joins after its already sent???

EXTERNAL:

GET /notifications

- Gathers all the active notifications for the member fo the past 2mo  
  - Must be paginated  
  - Sends following body:  
    - Body recieved:  
      - \[{‘headline’: string // the notification headline  
      - , ‘subheadline’: string // the notification subheadline  
      - , clicked: bool // whether the notification has ever been clicked,  
      - ‘liveDate’:  string // when the notification goes/went live in MM-DD-YYYY-HH-MM format}\]  
      - Sorted in date order descending order  
      - Status 200  
  - Possibly cache the results for quicker loading next batch

GET / notifications/:id 

- Gets all the information to that specific notification  
  - {‘image’: string // the completed url link to the img  
  - ‘headline’: string // the notification’s headline  
  - ‘subheadline’: string // the notification’s subheadline  
  - ‘link’: string // the completed url to the link   
  -  ‘liveDate’:  string // when the notification goes/went live in MM-DD-YYYY-HH-MM format  
  - Status 200  
- On the backend side should update is\_clicked to true if has not been done so (maybe we just cache these there needs to be a more performant way to do this)  
- Need to use workers for this to be able to batch sending out notifications, if active