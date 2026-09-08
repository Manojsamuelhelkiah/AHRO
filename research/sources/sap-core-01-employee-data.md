Source: https://help.sap.com/docs/successfactors-employee-central/implementing-employee-central-core/employee-data-hr-information
Title: Employee Data - HR Information | SAP Help Portal
Fetched: 2026-09-08T16:20:28.995Z

# Implementing Employee Central Core

English

Provide feedback on our search



# Employee Data - HR Information

Assign permissions for cards that refer to non-effective dated entities. Non-effective
dated means that the history for the changes is not stored in the system (for example, for
Phone Information).

The entries listed here refer to the different cards that have been defined as HRIS elements
in the Succession Data Model.

These settings are available for each entry listed:

- View: The user can see the card.

- Edit: The user can edit the card on the Personal Information or
Employment Details by selecting the Edit link in the
card.


Note that the labels depend on the labels defined in the Succession Data Model. If you
have taken over the standard Succession Data Model, the
following entries are displayed under HR Information:

| HR Information Permission Setting | HRIS Element | Description |
| --- | --- | --- |
| User PermissionsEmployee DataHR Information | Biographical Information ( `personInfo`) | Admins with this permission can access personal data of a<br>user. |
| User PermissionsEmployee DataHR Information | National ID Information ( `nationalIdCard)` | Admins with this permission can access the national ID<br>information of a user. |
| User PermissionsEmployee DataHR Information | National ID (Restricted to only country/region of legal<br>entity)<br>( `nationalIdCard`) | Admins with this permission can only access the national ID<br>information of an employee relevant to the country or region of<br>the legal entity where the employee is currently employed. For<br>example, an administrator responsible for an employee currently<br>employed in the United States can’t view or add national ID<br>information related to other countries or regions for the<br>employee. <br>For an employee with multiple assignments or employments in<br>different countries or regions, if the responsible<br>administrators with this permission can access an assignment,<br>they only view and edit the national ID information relevant to<br>the assignment. <br>Note that selecting only View has the same<br>impact as selecting both View and<br>Edit, that is, administrators can<br>both view and edit the relevant national ID information. |
| User PermissionsEmployee DataHR Information | Phone Information ( `phoneInfo`) | Admins with this permission can access personal data of a<br>user. |
| User PermissionsEmployee DataHR Information | Email Information ( `emailInfo`) | Admins with this permission can access personal data of a<br>user. |
| User PermissionsEmployee DataHR Information | Business Email Address | This entry is an exception. It refers to one of the email types<br>of the `emailInfo` element: business email<br>address. <br>It is listed here because normally every employee needs a<br>business email address. If a company assigns the email addresses<br>to the employees and does not want them to be editable by the<br>employees, select only View permission<br>here. |
| User PermissionsEmployee DataHR Information | Social Accounts Information ( `imInfo`) | Admins with this permission can access personal data of a<br>user. |
| User PermissionsEmployee DataHR Information | Primary Emergency Contact<br>( `emergencyContactPrimary`) | Admins with this permission can access personal data of a<br>user. |
| User PermissionsEmployee DataHR Information | Spot Bonus ( `payComponentNonRecurring`) | Users with this permission can view the Spot Bonus card on the Employment Details.<br>The Edit permissions allows users to navigate from the Employment<br>Details to the Update Employee Records<br>page using the Take Action menu. |
| User PermissionsEmployee DataHR Information | Spot Bonus Edit Action <br>`(payComponentNonRecurring)` | Users with this permission can change what data employees are allowed to change on the<br>Employment Details. |
| User PermissionsEmployee DataHR Information | Payment Information ( `paymentInfo`) | Admins with this permission can access personal data of a<br>user. |
| User PermissionsEmployee DataHR Information | Work Permit Info ( `workPermitInfo`) | Admins with this permission can access personal data of a<br>user. |
| User PermissionsEmployee DataHR Information | Global Assignment Details<br>( `globalAssignmentInfo`) | This entry is only displayed when Global Assignments Management<br>are active in the system. <br>Admins with the Edit permission can manage<br>global assignments on the Update Employee<br>Records page using the Take<br>Action menu. |
| User PermissionsEmployee DataHR Information | Pension Payout Details ( `pensionPayoutsInfo`) | This entry is only displayed when pension payouts are active in<br>the system.<br>The Edit permissions allows the user to<br>manage pension payouts on the Update Employee<br>Records page using the Take<br>Action menu. |
| User PermissionsEmployee DataHR Information | Business Address | Normally every employee needs a business address. If a company<br>assigns the addresses to the employees and does not want them to<br>be editable by the employees, select only<br>View permission here. |
| User PermissionsEmployee DataHR Information | Pay Targets | Admins and managers with this permission can view and edit the pay targets section of the<br>Compensation Information . <br>If a user doesn't have permission to see pay targets, then the entire Pay Targets section<br>of the Compensation card is hidden. |





Related Information

[List of Role-Based Permissions](https://help.sap.com/docs/successfactors-employee-central/implementing-employee-central-core/d77b76e71cf54201a4049906b9d8145a.html?locale=en-US&state=PRODUCTION&version=2605 "This is a main list of role-based permissions used across the SAP SuccessFactors HCM suite.")