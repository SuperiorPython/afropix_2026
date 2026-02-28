function downloadICS(date, task) {
    const cleanDate = date.replace(/-/g, ''); 
    const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:LEGAL DEADLINE: ${task}
DTSTART:${cleanDate}T090000Z
DESCRIPTION:Reminder from B&E Solutions.
END:VEVENT
END:VCALENDAR`;

    const blob = new Blob([icsContent], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'legal_deadline.ics';
    link.click();
}